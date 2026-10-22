// Auditoria cega semanal por amostragem: mede se as contagens do sistema são confiáveis.
// A cada semana ISO sorteia endereços com estoque (peso = exposição), entrega cada um a um operador diferente de quem
// contou por último, e compara a contagem CEGA (sem ver a quantidade do sistema) com o saldo. O resultado vira
// eventos CONTAGEM com motivo "Auditoria: confere" ou "Auditoria: diferença" — a contagem também corrige o estoque.
const crypto = require('node:crypto');
const S = require('./service');
const U = require('./util');
const A = require('./auth');

const { HttpError } = U;
const N_PADRAO = 5, N_MIN = 3, N_MAX = 10;
const MOTIVO_OK = 'Auditoria: confere', MOTIVO_DIF = 'Auditoria: diferença';

// ---------- semana ISO ----------
function semanaISO(dia = U.hojeISO()) {
  const d = new Date(dia + 'T00:00:00Z');
  const quinta = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * 864e5);   // a quinta-feira define o ano ISO
  const ano = quinta.getUTCFullYear();
  const sem = Math.ceil(((quinta - Date.UTC(ano, 0, 1)) / 864e5 + 1) / 7);
  return `${ano}-W${String(sem).padStart(2, '0')}`;
}
const semanasAte = (n, hoje = U.hojeISO()) => {   // da mais antiga para a atual
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(semanaISO(U.hojeISO(new Date(new Date(hoje + 'T12:00:00Z').getTime() - i * 7 * 864e5))));
  return [...new Set(out)];
};

// ---------- sorteio determinístico ----------
const hash32 = txt => crypto.createHash('sha256').update(txt).digest().readUInt32BE(0);
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Amostragem ponderada sem reposição (Efraimidis-Spirakis) com semente = semana + lista de endereços.
// Mesma semana + mesma lista => mesmo resultado, em qualquer aparelho.
function sortear({ semana, candidatos, n }) {
  const lista = [...candidatos].sort((a, b) => a.endereco.localeCompare(b.endereco));
  const rnd = mulberry32(hash32(`${semana}|${lista.map(c => c.endereco).join(',')}`));
  return lista
    .map(c => ({ endereco: c.endereco, chave: Math.log(rnd() || 1e-12) / (Math.max(0, c.exposicao || 0) + 1) }))
    .sort((a, b) => b.chave - a.chave || a.endereco.localeCompare(b.endereco))
    .slice(0, n)
    .map(x => x.endereco);
}

// Cada endereço vai para um operador diferente de quem contou por último; equilibra a carga entre os operadores.
// Com um único operador não há como separar: atribui a ele e marca mesmo_operador.
function atribuir({ semana, enderecos, ultimo, operadores }) {
  const carga = new Map(operadores.map(o => [o, 0]));
  return enderecos.map(endereco => {
    const ult = ultimo[endereco] || null;
    let pool = operadores.filter(o => o !== ult);
    let mesmo = false;
    if (!pool.length && operadores.length) { pool = operadores; mesmo = true; }
    pool = [...pool].sort((a, b) => carga.get(a) - carga.get(b) || hash32(`${semana}|${endereco}|${a}`) - hash32(`${semana}|${endereco}|${b}`));
    const auditor = pool[0] || null;
    if (auditor) carga.set(auditor, carga.get(auditor) + 1);
    return { endereco, auditor, ultimo_contador: ult, mesmo_operador: mesmo && !!ult };
  });
}

// ---------- configuração e plano ----------
async function cfgGet(db, chave) {
  const r = await db.get('SELECT valor FROM config WHERE chave=?', [chave]);
  if (!r) return null;
  try { return JSON.parse(r.valor); } catch { return null; }
}
async function getN(db) {
  const n = await cfgGet(db, 'auditoria_n');
  return Number.isInteger(n) && n >= N_MIN && n <= N_MAX ? n : N_PADRAO;
}
async function setN(db, n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < N_MIN || n > N_MAX) throw new HttpError(400, `o número de endereços por semana deve ficar entre ${N_MIN} e ${N_MAX}`);
  await db.run('INSERT INTO config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor', ['auditoria_n', JSON.stringify(n)]);
  return { n };
}

async function ultimosContadores(db) {
  const mapa = {};
  for (const tipo of ['RECEBIMENTO', 'CONTAGEM']) {          // CONTAGEM por último: vale sobre o recebimento
    const rs = await db.all(`SELECT DISTINCT ON (endereco) endereco, operador FROM eventos
      WHERE tipo=? AND desfeito=0 AND historico=0 AND operador IS NOT NULL ORDER BY endereco, ts DESC, id DESC`, [tipo]);
    for (const r of rs) mapa[r.endereco] = String(r.operador).toUpperCase();
  }
  return mapa;
}

async function planoDaSemana(db, semana = semanaISO()) {
  const chave = `auditoria_plano:${semana}`;
  let plano = await cfgGet(db, chave);
  if (plano) return plano;
  const lotes = await S.lotesAtivos(db);
  const exp = new Map();
  const pm = S.precoMediano(lotes);
  for (const l of lotes) if (l.endereco) exp.set(l.endereco, (exp.get(l.endereco) || 0) + S.exposicaoLote(l, pm));
  const candidatos = [...exp].map(([endereco, exposicao]) => ({ endereco, exposicao }));
  const n = await getN(db);
  const enderecos = sortear({ semana, candidatos, n });
  const operadores = (await A.nomesAtivos(db)).map(x => String(x).toUpperCase());
  const itens = atribuir({ semana, enderecos, ultimo: await ultimosContadores(db), operadores });
  plano = { semana, n, criado_em: U.agoraISO(), itens };
  // duas requisições simultâneas: vale a primeira que gravar
  await db.run('INSERT INTO config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO NOTHING', [chave, JSON.stringify(plano)]);
  return (await cfgGet(db, chave)) || plano;
}

// ---------- leitura dos eventos de auditoria ----------
const OBS_RE = /^Auditoria (\d{4}-W\d{2})\|ult=([^|]*)(\|extra=1)?$/;
async function eventosAuditoria(db, { desde = null, semana = null } = {}) {
  const where = ["e.motivo LIKE 'Auditoria:%'", 'e.desfeito=0', 'e.historico=0', "e.tipo='CONTAGEM'"];
  const args = [];
  if (semana) { where.push('e.obs LIKE ?'); args.push(`Auditoria ${semana}|%`); }
  if (desde) { where.push('e.ts >= ?'); args.push(desde); }
  const rows = await db.all(`SELECT e.id, e.ts, e.endereco, e.ean, e.lote, e.validade, e.operador, e.motivo, e.obs, e.qtd_antes, e.qtd_depois, p.nome
    FROM eventos e LEFT JOIN produtos p ON p.ean=e.ean WHERE ${where.join(' AND ')} ORDER BY e.ts, e.id`, args);
  return rows.map(r => {
    const m = String(r.obs || '').match(OBS_RE);
    return m ? { ...r, semana: m[1], ult: m[2] || null, extra: !!m[3], sistema: r.qtd_antes, contado: r.qtd_depois, confere: r.motivo === MOTIVO_OK } : null;
  }).filter(Boolean);
}

const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : null);

function resumoEndereco(evs, endereco) {
  const meus = evs.filter(e => e.endereco === endereco);
  const confere = meus.filter(e => e.confere).length;
  return {
    lotes: meus.length, confere, diferencas: meus.length - confere, acuracia: pct(confere, meus.length),
    auditor: meus[0]?.operador || null, quando: meus[meus.length - 1]?.ts || null,
    itens: meus.map(e => ({ ean: e.ean, nome: e.nome || e.ean, lote: e.lote, validade: e.validade, sistema: e.sistema, contado: e.contado, confere: e.confere, extra: e.extra })),
  };
}

async function auditoria(db, { operador = null } = {}) {
  const semana = semanaISO();
  const [plano, evs] = await Promise.all([planoDaSemana(db, semana), eventosAuditoria(db, { semana })]);
  const op = operador ? String(operador).toUpperCase() : null;
  const itens = plano.itens.map(i => {
    const r = resumoEndereco(evs, i.endereco);
    const feito = r.lotes > 0;
    return { ...i, descricao: U.parseEndereco(i.endereco).valido ? undefined : 'fora do padrão', meu: !!op && (i.auditor === op || i.auditor === null), status: feito ? 'feito' : 'pendente', resultado: feito ? r : null };
  });
  const feitos = itens.filter(i => i.status === 'feito');
  const lotes = feitos.reduce((s, i) => s + i.resultado.lotes, 0), confere = feitos.reduce((s, i) => s + i.resultado.confere, 0);
  return {
    semana, n: plano.n, n_min: N_MIN, n_max: N_MAX, itens,
    progresso: { feitos: feitos.length, total: itens.length, lotes, confere, acuracia: pct(confere, lotes) },
  };
}

async function painel(db, { semanas = 8, admin = false } = {}) {
  semanas = Math.max(1, Math.min(26, Math.round(+semanas) || 8));
  const lista = semanasAte(semanas);
  const desde = new Date(Date.now() - (semanas * 7 + 8) * 864e5).toISOString();
  const evs = (await eventosAuditoria(db, { desde })).filter(e => lista.includes(e.semana));
  const atual = lista[lista.length - 1];
  const porSemana = lista.map(s => {
    const x = evs.filter(e => e.semana === s), confere = x.filter(e => e.confere).length;
    return { semana: s, lotes: x.length, confere, diferencas: x.length - confere, enderecos: new Set(x.map(e => e.endereco)).size, acuracia: pct(confere, x.length) };
  });
  const anteriores = porSemana.filter(s => s.semana !== atual && s.lotes > 0);
  const ultima = anteriores[anteriores.length - 1] || porSemana.filter(s => s.lotes > 0).pop() || null;
  const plano = await planoDaSemana(db, atual);
  const doPlano = new Set(plano.itens.map(i => i.endereco));
  const auditados = new Set(evs.filter(e => e.semana === atual && doPlano.has(e.endereco)).map(e => e.endereco)).size;
  const total = evs.length, okTotal = evs.filter(e => e.confere).length;
  const out = {
    semanas: porSemana,
    atual: { semana: atual, planejados: plano.itens.length, auditados },
    ultima: ultima ? { semana: ultima.semana, acuracia: ultima.acuracia, lotes: ultima.lotes } : null,
    geral: { lotes: total, confere: okTotal, acuracia: pct(okTotal, total) },
  };
  if (admin) {
    // Atribuído a quem fez a contagem anterior do endereço: mede o processo (a contagem que gerou o saldo), não a pessoa.
    const por = new Map();
    for (const e of evs) {
      const k = e.ult || 'sem registro';
      const r = por.get(k) || { operador: k, lotes: 0, confere: 0 };
      r.lotes++; if (e.confere) r.confere++;
      por.set(k, r);
    }
    out.por_operador = [...por.values()].map(r => ({ ...r, acuracia: pct(r.confere, r.lotes) })).sort((a, b) => b.lotes - a.lotes);
    out.nota = 'Mede a qualidade do processo de contagem (o saldo que o sistema tinha), não o desempenho de uma pessoa.';
  }
  return out;
}

// ---------- contagem cega ----------
function checaAuditor(item, operador) {
  const op = operador ? String(operador).toUpperCase() : '';
  if (item.auditor && item.auditor !== op) throw new HttpError(403, `este endereço foi atribuído a ${item.auditor}`);
}
async function itemDoPlano(db, endereco) {
  const end = U.normEndereco(endereco);
  const plano = await planoDaSemana(db);
  const item = plano.itens.find(i => i.endereco === end);
  if (!item) throw new HttpError(404, 'este endereço não está na auditoria desta semana');
  return { plano, item, end };
}

// O que o operador vê: lote, validade, produto. NUNCA a quantidade do sistema (nem valor, que a revelaria).
async function cego(db, { endereco, operador }) {
  const { plano, item, end } = await itemDoPlano(db, endereco);
  checaAuditor(item, operador);
  const feito = await eventosAuditoria(db, { semana: plano.semana });
  if (feito.some(e => e.endereco === end)) return { semana: plano.semana, endereco: end, ja_feito: true, resultado: resumoEndereco(feito, end), lotes: [] };
  const rows = await db.all(`SELECT l.id, l.ean, l.lote, l.validade, p.nome, p.marca FROM lotes l LEFT JOIN produtos p ON p.ean=l.ean
    WHERE l.endereco=? AND l.qtd>0 ORDER BY l.validade, l.id`, [end]);
  return {
    semana: plano.semana, endereco: end, ja_feito: false,
    lotes: rows.map(r => ({ id: r.id, ean: r.ean, nome: r.nome || r.ean, marca: r.marca || null, lote: r.lote, validade: r.validade })),
  };
}

async function concluir(db, { endereco, itens = [], extras = [], operador }) {
  const { plano, item, end } = await itemDoPlano(db, endereco);
  checaAuditor(item, operador);
  if (!operador) throw new HttpError(400, 'informe o operador');
  const semana = plano.semana;
  const antes = await eventosAuditoria(db, { semana });
  if (antes.some(e => e.endereco === end)) throw new HttpError(409, 'este endereço já foi auditado nesta semana');
  const lotes = await db.all('SELECT id, ean, lote, validade, qtd FROM lotes WHERE endereco=? AND qtd>0 ORDER BY validade, id', [end]);
  const resp = new Map();
  for (const it of Array.isArray(itens) ? itens : []) {
    const q = Number(it.qtd);
    if (!Number.isInteger(q) || q < 0 || it.qtd === '' || it.qtd === null) throw new HttpError(400, 'quantidade inválida');
    resp.set(Number(it.lote_id), q);
  }
  for (const id of resp.keys()) if (!lotes.some(l => l.id === id)) throw new HttpError(400, 'lote que não pertence a este endereço');
  const falta = lotes.filter(l => !resp.has(l.id));
  if (falta.length) throw new HttpError(400, `falta informar a quantidade de ${falta.length} lote(s)`);

  // valida os lotes achados fora da lista antes de gravar qualquer coisa
  const novos = [];
  for (const x of Array.isArray(extras) ? extras : []) {
    const q = Number(x.qtd);
    if (!Number.isInteger(q) || q < 0) throw new HttpError(400, 'quantidade inválida num lote fora da lista');
    if (q === 0) continue;
    const p = await S.getProduto(db, x.ean);
    const ean = p ? p.ean : U.normEan(x.ean);
    if (!ean) throw new HttpError(400, 'EAN inválido num lote fora da lista');
    if (!p && !x.nome) throw new HttpError(422, `EAN ${ean} não cadastrado — informe o nome do produto`);
    const validade = U.parseData(x.validade);
    if (!validade) throw new HttpError(400, 'validade inválida num lote fora da lista');
    const nomeLote = U.normLote(x.lote);
    if (lotes.some(l => l.ean === ean && l.lote === nomeLote && l.validade === validade)) throw new HttpError(400, `o lote ${nomeLote} já está na lista deste endereço`);
    novos.push({ ean, nome: x.nome, preco: x.preco, lote: nomeLote, validade, qtd: q });
  }

  const ult = String(item.ultimo_contador || '').replace(/\|/g, '');
  const grava = (corpo, i) => S.leitura(db, { tipo: 'CONTAGEM', operador, ...corpo, client_id: `aud-${semana}-${end}-${i}` });
  for (const l of lotes) {
    const q = resp.get(l.id);
    await grava({ lote_id: l.id, qtd: q, motivo: q === l.qtd ? MOTIVO_OK : MOTIVO_DIF, obs: `Auditoria ${semana}|ult=${ult}` }, `l${l.id}`);
  }
  for (const [i, x] of novos.entries()) {
    await grava({ ean: x.ean, nome: x.nome, preco: x.preco, lote: x.lote, validade: x.validade, endereco: end, qtd: x.qtd, motivo: MOTIVO_DIF, obs: `Auditoria ${semana}|ult=${ult}|extra=1` }, `x${i}-${x.ean}-${x.lote}`);
  }
  const evs = await eventosAuditoria(db, { semana });
  return { ok: true, semana, endereco: end, resultado: resumoEndereco(evs, end) };
}

// ---------- rotas (acrescentadas à tabela de lib/app.js) ----------
const quem = c => (c.user ? c.user.nome : String(c.q.get('operador') || c.body.operador || '').trim().toUpperCase());
const ehAdmin = c => !A.loginObrigatorio() || (c.user && c.user.papel === 'admin');
const ROTAS = [
  ['GET', /^\/api\/auditoria$/, {}, c => auditoria(c.db, { operador: quem(c) })],
  ['GET', /^\/api\/auditoria\/painel$/, {}, c => painel(c.db, { semanas: c.q.get('semanas'), admin: ehAdmin(c) })],
  ['GET', /^\/api\/auditoria\/endereco\/([^/]+)$/, {}, c => cego(c.db, { endereco: decodeURIComponent(c.m[0]), operador: quem(c) })],
  ['POST', /^\/api\/auditoria\/concluir$/, {}, c => concluir(c.db, { ...c.body, operador: c.operador })],
  ['PUT', /^\/api\/auditoria\/config$/, { admin: true }, c => setN(c.db, c.body.n)],
];

module.exports = { ROTAS, semanaISO, semanasAte, sortear, atribuir, planoDaSemana, auditoria, painel, cego, concluir, getN, setN, MOTIVO_OK, MOTIVO_DIF };
