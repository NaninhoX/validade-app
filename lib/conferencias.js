'use strict';
// Conferências: sessões de bipagem em rajada (recebimento, validade, contagem) e o resumo automático da ronda do dia.
//   RECEBIMENTO  EAN + quantidade; só registra, NÃO mexe no estoque.
//   VALIDADE     EAN + lote + validade (+ endereço opcional); cada leitura entra no estoque como RECEBIMENTO (FEFO).
//   CONTAGEM     EAN + quantidade (+ endereço opcional); só registra.
//   RONDA        resumo somente leitura, criado sozinho quando o coletor encerra a Ronda do dia.
// A mesma leitura (client_id) pode chegar mais de uma vez (fila offline): nunca soma duas vezes.
const crypto = require('node:crypto');
const S = require('./service');
const U = require('./util');

const { HttpError } = U;

const TIPOS = ['RECEBIMENTO', 'VALIDADE', 'CONTAGEM'];   // os que a pessoa abre; RONDA nasce do coletor
const QTD_MAX = 100000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conferencias (
    id BIGSERIAL PRIMARY KEY, tipo TEXT NOT NULL, operador TEXT NOT NULL, nota TEXT, aberta_em TEXT NOT NULL,
    fechada_em TEXT, obs TEXT, endereco TEXT, client_id TEXT UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS ix_conf_aberta ON conferencias(aberta_em)`,
  // Aberta (bipando) -> Finalizada (fechada) -> Processada (lançada no sistema da loja pelo setor responsável)
  `ALTER TABLE conferencias ADD COLUMN IF NOT EXISTS processada_em TEXT`,
  `ALTER TABLE conferencias ADD COLUMN IF NOT EXISTS processada_por TEXT`,
  // esperado: reservado para a futura carga da NF (verde = igual, vermelho = a mais, laranja = a menos); na RONDA guarda o saldo do sistema
  `CREATE TABLE IF NOT EXISTS conferencia_itens (
    id BIGSERIAL PRIMARY KEY, conferencia_id BIGINT NOT NULL, ean TEXT NOT NULL, qtd INTEGER NOT NULL DEFAULT 1,
    lote TEXT, validade TEXT, endereco TEXT, esperado INTEGER, grupos TEXT, client_id TEXT UNIQUE,
    criado_em TEXT NOT NULL, atualizado_em TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_confit_conf ON conferencia_itens(conferencia_id)`,
  // leituras já aplicadas (uma linha por client_id): é o que torna o reenvio da fila offline inofensivo
  `CREATE TABLE IF NOT EXISTS conferencia_ops (client_id TEXT PRIMARY KEY, conferencia_id BIGINT NOT NULL)`,
];

const COL = new Intl.Collator('pt-BR', { sensitivity: 'base' });   // sem diferença de acento e caixa
const nomeOrdem = i => i.nome || i.ean;
const comparaItens = (a, b) => COL.compare(nomeOrdem(a), nomeOrdem(b)) || COL.compare(a.lote || '', b.lote || '')
  || (a.validade || '').localeCompare(b.validade || '') || COL.compare(a.endereco || '', b.endereco || '') || a.ean.localeCompare(b.ean) || a.id - b.id;

const minutos = (de, ate) => Math.max(0, Math.round(((ate ? Date.parse(ate) : Date.now()) - Date.parse(de)) / 60000));
const txt = (v, max) => { const s = v === undefined || v === null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };

function inteiro(v, nome, min = 1) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > QTD_MAX) throw new HttpError(400, `${nome} inválida`);
  return n;
}

function enderecoOuNulo(v) {
  const e = U.normEndereco(v);
  if (!e) return null;
  const erro = U.erroEndereco(e);
  if (erro) throw new HttpError(400, erro);
  return e;
}

const SQL_STATS = `SELECT c.*, COALESCE(s.itens,0) AS itens, COALESCE(s.linhas,0) AS linhas, COALESCE(s.eans,0) AS eans
  FROM conferencias c LEFT JOIN (SELECT conferencia_id, SUM(qtd) AS itens, COUNT(*) AS linhas, COUNT(DISTINCT ean) AS eans
    FROM conferencia_itens GROUP BY conferencia_id) s ON s.conferencia_id = c.id`;

function formata(c) {
  return { ...c, id: Number(c.id), itens: Number(c.itens), linhas: Number(c.linhas), eans: Number(c.eans),
    aberta: !c.fechada_em, minutos: minutos(c.aberta_em, c.fechada_em),
    processada: !!c.processada_em, min_ate_processar: c.fechada_em && c.processada_em ? minutos(c.fechada_em, c.processada_em) : null };
}

async function obter(db, id) {
  const c = await db.get(`${SQL_STATS} WHERE c.id = ?`, [Number(id)]);
  if (!c) throw new HttpError(404, 'conferência não encontrada');
  return formata(c);
}

function exigeAberta(c) {
  if (c.tipo === 'RONDA') throw new HttpError(409, 'O resumo da ronda é somente leitura');
  if (!c.aberta) throw new HttpError(409, 'Esta conferência já foi fechada e não pode mais ser alterada');
}

// ---------- sessão ----------
// horário informado pelo aparelho (conferência feita offline): vale se for uma data válida e não estiver no futuro
const tsAparelho = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) && t <= Date.now() + 5 * 60000 && t > Date.now() - 31 * 864e5 ? new Date(t).toISOString() : U.agoraISO(); };

async function abrir(db, { tipo, operador, nota, endereco, obs, client_id, ts }) {
  tipo = String(tipo || '').toUpperCase();
  if (!TIPOS.includes(tipo)) throw new HttpError(400, `tipo deve ser um de ${TIPOS.join(', ')}`);
  operador = String(operador || '').trim();
  if (!operador) throw new HttpError(400, 'informe o operador');
  const cid = txt(client_id, 80);
  if (cid) {
    const ex = await db.get('SELECT id FROM conferencias WHERE client_id = ?', [cid]);
    if (ex) return obter(db, ex.id);
  }
  const end = tipo === 'RECEBIMENTO' ? null : enderecoOuNulo(endereco);
  try {
    const r = await db.get('INSERT INTO conferencias(tipo, operador, nota, aberta_em, obs, endereco, client_id) VALUES(?,?,?,?,?,?,?) RETURNING id',
      [tipo, operador, txt(nota, 40), tsAparelho(ts), txt(obs, 300), end, cid]);
    return obter(db, r.id);
  } catch (e) {
    if (e && e.code === '23505' && cid) return obter(db, (await db.get('SELECT id FROM conferencias WHERE client_id = ?', [cid])).id);
    throw e;
  }
}

async function atualizar(db, id, d) {
  const c = await obter(db, id);
  exigeAberta(c);
  const nota = d.nota !== undefined ? txt(d.nota, 40) : c.nota;
  const obs = d.obs !== undefined ? txt(d.obs, 300) : c.obs;
  const endereco = d.endereco !== undefined && c.tipo !== 'RECEBIMENTO' ? enderecoOuNulo(d.endereco) : c.endereco;
  await db.run('UPDATE conferencias SET nota=?, obs=?, endereco=? WHERE id=?', [nota, obs, endereco, c.id]);
  return obter(db, c.id);
}

async function fechar(db, id, ts) {
  const c = await obter(db, id);
  if (!c.aberta) return c;                       // fechar de novo não muda nada
  exigeAberta(c);
  if (!c.linhas) throw new HttpError(400, 'Nenhum item foi lido. Apague a conferência em vez de fechar.');
  await db.run('UPDATE conferencias SET fechada_em=? WHERE id=? AND fechada_em IS NULL', [Date.parse(tsAparelho(ts)) >= Date.parse(c.aberta_em) ? tsAparelho(ts) : U.agoraISO(), c.id]);
  return obter(db, c.id);
}

// "Processada": o setor responsável já lançou esta conferência no sistema da loja. Só depois de finalizada; processar de novo não muda nada.
async function processar(db, id, operador) {
  const c = await obter(db, id);
  if (c.tipo === 'RONDA') throw new HttpError(409, 'O resumo da ronda não precisa ser processado');
  if (c.aberta) throw new HttpError(409, 'Finalize a conferência antes de marcar como processada');
  if (c.processada) return c;
  await db.run('UPDATE conferencias SET processada_em=?, processada_por=? WHERE id=? AND processada_em IS NULL', [U.agoraISO(), String(operador || '').slice(0, 40) || null, c.id]);
  return obter(db, c.id);
}

async function apagar(db, id) {
  const c = await obter(db, id);
  exigeAberta(c);
  for (const it of await db.all('SELECT * FROM conferencia_itens WHERE conferencia_id=? ORDER BY id DESC', [c.id])) await desfazerEstoque(db, it);
  await db.tx(async t => {
    await t.run('DELETE FROM conferencia_itens WHERE conferencia_id=?', [c.id]);
    await t.run('DELETE FROM conferencia_ops WHERE conferencia_id=?', [c.id]);
    await t.run('DELETE FROM conferencias WHERE id=?', [c.id]);
  });
  return { ok: true };
}

// filtros: tipo, operador, data (um dia, fuso da loja) ou de/ate (AAAA-MM-DD)
async function listar(db, { tipo, operador, data, de, ate, limite } = {}) {
  const where = [], args = [];
  if (tipo) { where.push('c.tipo = ?'); args.push(String(tipo).toUpperCase()); }
  if (operador) { where.push('UPPER(c.operador) = ?'); args.push(String(operador).trim().toUpperCase()); }
  const dia = x => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : null);
  const d0 = dia(data) || dia(de), d1 = dia(data) || dia(ate);
  // janela larga em UTC; o corte exato é feito abaixo, no dia da loja
  if (d0) { where.push('c.aberta_em >= ?'); args.push(new Date(Date.parse(d0 + 'T00:00:00Z') - 864e5).toISOString()); }
  if (d1) { where.push('c.aberta_em < ?'); args.push(new Date(Date.parse(d1 + 'T00:00:00Z') + 2 * 864e5).toISOString()); }
  let rows = await db.all(`${SQL_STATS} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.aberta_em DESC, c.id DESC LIMIT 1000`, args);
  rows = rows.map(formata);
  if (d0 || d1) rows = rows.filter(c => { const dd = U.hojeISO(new Date(c.aberta_em)); return (!d0 || dd >= d0) && (!d1 || dd <= d1); });
  return rows.slice(0, Math.min(+limite || 200, 500));
}

// ---------- itens ----------
const chaveItem = i => [i.ean, i.lote || '', i.validade || '', i.endereco || ''];

async function itens(db, c) {
  if (c.tipo === 'RONDA') await sincronizaRonda(db, c);
  const rows = await db.all(`SELECT i.*, p.nome FROM conferencia_itens i LEFT JOIN produtos p ON p.ean = i.ean WHERE i.conferencia_id = ?`, [c.id]);
  return rows.map(r => ({ ...r, id: Number(r.id), qtd: Number(r.qtd), esperado: r.esperado === null ? null : Number(r.esperado), grupos: undefined })).sort(comparaItens);
}

async function detalhe(db, id) {
  let c = await obter(db, id);
  const lista = await itens(db, c);
  if (c.tipo === 'RONDA') c = await obter(db, id);
  return { conferencia: c, itens: lista };
}

async function acharItem(db, confId, ref) {
  const r = String(ref);
  const it = /^\d+$/.test(r) ? await db.get('SELECT * FROM conferencia_itens WHERE id=? AND conferencia_id=?', [Number(r), confId])
    : await db.get('SELECT * FROM conferencia_itens WHERE client_id=? AND conferencia_id=?', [r, confId]);
  if (!it) throw new HttpError(404, 'item não encontrado');
  return it;
}

const gruposDe = it => { try { return JSON.parse(it.grupos || '[]'); } catch { return []; } };

// VALIDADE: desfaz no estoque o que este item lançou (do mais novo para o mais antigo)
async function desfazerEstoque(db, it) {
  for (const g of gruposDe(it).reverse()) {
    try { await S.desfazer(db, g); }
    catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e; }   // 404: já desfeito
  }
}

async function adicionarItem(db, id, d, operador) {
  const c = await obter(db, id);
  exigeAberta(c);
  const cid = txt(d.client_id, 80) || crypto.randomUUID();
  if (await db.get('SELECT 1 AS x FROM conferencia_ops WHERE client_id = ?', [cid])) {
    return { ok: true, duplicado: true, conferencia: await obter(db, id), avisos: [] };
  }
  let p = await S.getProduto(db, d.ean);
  const ean = p ? p.ean : U.normEan(d.ean);
  if (!ean) throw new HttpError(400, 'EAN inválido');
  if (!p) {
    if (!txt(d.nome, 120)) throw new HttpError(422, 'EAN não cadastrado — informe o nome para cadastrar');
    p = await S.upsertProduto(db, { ean, nome: d.nome, preco: d.preco, marca: d.marca, operador, confirmar: d.preco !== undefined && d.preco !== null && d.preco !== '' });
  }
  const qtd = inteiro(d.qtd === undefined || d.qtd === '' ? 1 : d.qtd, 'quantidade');
  const ts = d.ts && !isNaN(Date.parse(d.ts)) ? new Date(d.ts).toISOString() : U.agoraISO();
  let lote = null, validade = null, endereco = null, grupo = null, avisos = [];
  if (c.tipo === 'VALIDADE') {
    validade = U.parseData(d.validade);
    if (!validade) throw new HttpError(400, 'validade inválida');
    lote = U.normLote(d.lote);
  }
  if (c.tipo !== 'RECEBIMENTO') endereco = enderecoOuNulo(d.endereco !== undefined ? d.endereco : c.endereco);
  if (c.tipo === 'VALIDADE') {
    const r = await S.leitura(db, { tipo: 'RECEBIMENTO', ean: p.ean, lote, validade, qtd, endereco: endereco || '', sem_endereco: !endereco,
      operador, ts, obs: `Conferência #${c.id}`, client_id: `conf-${cid}` });
    grupo = r.grupo; avisos = r.avisos || [];
  }
  const item = await db.tx(async t => {
    const novo = await t.run('INSERT INTO conferencia_ops(client_id, conferencia_id) VALUES(?,?) ON CONFLICT DO NOTHING', [cid, c.id]);
    if (!novo.changes) return null;                                   // outra requisição igual venceu a corrida
    const k = { ean: p.ean, lote, validade, endereco };
    const ex = await t.get(`SELECT * FROM conferencia_itens WHERE conferencia_id=? AND ean=? AND COALESCE(lote,'')=? AND COALESCE(validade,'')=? AND COALESCE(endereco,'')=?`,
      [c.id, ...chaveItem(k)]);
    if (ex) {
      const g = gruposDe(ex); if (grupo) g.push(grupo);
      await t.run('UPDATE conferencia_itens SET qtd = qtd + ?, grupos = ?, atualizado_em = ? WHERE id = ?', [qtd, JSON.stringify(g), ts, ex.id]);
      return ex.id;
    }
    const r = await t.get(`INSERT INTO conferencia_itens(conferencia_id, ean, qtd, lote, validade, endereco, grupos, client_id, criado_em, atualizado_em)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`, [c.id, p.ean, qtd, lote, validade, endereco, JSON.stringify(grupo ? [grupo] : []), cid, ts, ts]);
    return r.id;
  });
  const lista = await itens(db, c);
  return { ok: true, duplicado: item === null, item: lista.find(i => i.id === Number(item)) || null, nome: p.nome, conferencia: await obter(db, id), avisos };
}

async function editarItem(db, id, ref, d, operador) {
  const c = await obter(db, id);
  exigeAberta(c);
  const it = await acharItem(db, c.id, ref);
  const novo = {
    qtd: d.qtd !== undefined ? inteiro(d.qtd, 'quantidade') : Number(it.qtd),
    lote: it.lote, validade: it.validade, endereco: it.endereco,
  };
  if (c.tipo === 'VALIDADE') {
    if (d.lote !== undefined) novo.lote = U.normLote(d.lote);
    if (d.validade !== undefined) { novo.validade = U.parseData(d.validade); if (!novo.validade) throw new HttpError(400, 'validade inválida'); }
  }
  if (c.tipo !== 'RECEBIMENTO' && d.endereco !== undefined) novo.endereco = enderecoOuNulo(d.endereco);
  const mudou = novo.qtd !== Number(it.qtd) || novo.lote !== it.lote || novo.validade !== it.validade || (novo.endereco || null) !== (it.endereco || null);
  if (!mudou) return { ok: true, conferencia: c };
  let grupos = gruposDe(it);
  if (c.tipo === 'VALIDADE') {
    await desfazerEstoque(db, it);                                    // estorna o que o item lançou e lança de novo já corrigido
    const r = await S.leitura(db, { tipo: 'RECEBIMENTO', ean: it.ean, lote: novo.lote, validade: novo.validade, qtd: novo.qtd,
      endereco: novo.endereco || '', sem_endereco: !novo.endereco, operador, obs: `Conferência #${c.id} (corrigido)`, client_id: `conf-ed-${crypto.randomUUID()}` });
    grupos = [r.grupo];
  }
  await db.tx(async t => {
    const outro = await t.get(`SELECT * FROM conferencia_itens WHERE conferencia_id=? AND id<>? AND ean=? AND COALESCE(lote,'')=? AND COALESCE(validade,'')=? AND COALESCE(endereco,'')=?`,
      [c.id, it.id, ...chaveItem({ ean: it.ean, lote: novo.lote, validade: novo.validade, endereco: novo.endereco })]);
    const agora = U.agoraISO();
    if (outro) {                                                      // virou a mesma linha de outro item: soma
      await t.run('UPDATE conferencia_itens SET qtd = qtd + ?, grupos = ?, atualizado_em = ? WHERE id = ?',
        [novo.qtd, JSON.stringify([...gruposDe(outro), ...grupos]), agora, outro.id]);
      await t.run('DELETE FROM conferencia_itens WHERE id = ?', [it.id]);
    } else {
      await t.run('UPDATE conferencia_itens SET qtd=?, lote=?, validade=?, endereco=?, grupos=?, atualizado_em=? WHERE id=?',
        [novo.qtd, novo.lote, novo.validade, novo.endereco || null, JSON.stringify(grupos), agora, it.id]);
    }
  });
  return { ok: true, conferencia: await obter(db, id) };
}

async function removerItem(db, id, ref) {
  const c = await obter(db, id);
  exigeAberta(c);
  const it = await acharItem(db, c.id, ref);
  await desfazerEstoque(db, it);
  await db.run('DELETE FROM conferencia_itens WHERE id = ?', [it.id]);
  return { ok: true, conferencia: await obter(db, id) };
}

// ---------- RONDA ----------
// Itens = contagens "Ronda: …" do operador dentro da janela do turno. Montados na hora (e refeitos a cada leitura),
// então contagens que chegaram atrasadas da fila offline aparecem sozinhas.
async function sincronizaRonda(db, c) {
  const evs = await db.all(`SELECT id, ean, lote, validade, endereco, qtd_antes, qtd_depois FROM eventos
    WHERE tipo='CONTAGEM' AND desfeito=0 AND historico=0 AND motivo LIKE 'Ronda:%' AND UPPER(operador)=? AND ts >= ? AND ts <= ? ORDER BY ts, id`,
  [String(c.operador).toUpperCase(), c.aberta_em, c.fechada_em || U.agoraISO()]);
  const mapa = new Map();
  for (const e of evs) {
    const k = [e.ean, e.lote, e.validade, e.endereco].join('|');
    const x = mapa.get(k);
    if (x) { x.qtd = Number(e.qtd_depois); x.ev = e.id; } else mapa.set(k, { ...e, qtd: Number(e.qtd_depois), esperado: Number(e.qtd_antes), ev: e.id });
  }
  await db.tx(async t => {
    await t.run('DELETE FROM conferencia_itens WHERE conferencia_id = ?', [c.id]);
    for (const x of mapa.values()) {
      await t.run(`INSERT INTO conferencia_itens(conferencia_id, ean, qtd, lote, validade, endereco, esperado, client_id, criado_em) VALUES(?,?,?,?,?,?,?,?,?)`,
        [c.id, x.ean, x.qtd, x.lote, x.validade, x.endereco || null, x.esperado, `r${c.id}-e${x.ev}`, c.fechada_em || c.aberta_em]);
    }
  });
}

// inicio/fim: ISO ou milissegundos; client_id identifica o turno (reenviar não duplica)
async function registrarRonda(db, { operador, client_id, inicio, fim, feitos, total }) {
  operador = String(operador || '').trim();
  if (!operador) throw new HttpError(400, 'informe o operador');
  const data = v => { const t = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v); return isNaN(t) ? null : new Date(t).toISOString(); };
  const ini = data(inicio), end = data(fim);
  if (!ini || !end || end < ini) throw new HttpError(400, 'início e fim da ronda inválidos');
  const cid = `ronda:${operador.toUpperCase()}:${txt(client_id, 80) || ini}`;
  let ex = await db.get('SELECT id FROM conferencias WHERE client_id = ?', [cid]);
  if (!ex) {
    const obs = Number.isInteger(+feitos) && Number.isInteger(+total) ? `${+feitos} de ${+total} endereços` : null;
    try {
      ex = await db.get('INSERT INTO conferencias(tipo, operador, aberta_em, fechada_em, obs, client_id) VALUES(?,?,?,?,?,?) RETURNING id', ['RONDA', operador, ini, end, obs, cid]);
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      ex = await db.get('SELECT id FROM conferencias WHERE client_id = ?', [cid]);
    }
  }
  return detalhe(db, ex.id);
}

// ---------- cartão "Hoje" da Visão geral ----------
async function hoje(db) {
  const dia = U.hojeISO();
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  const naoHoje = ts => U.hojeISO(new Date(ts)) !== dia;
  let rondas = 0, conferencias = 0, abertas = 0;
  for (const c of await db.all('SELECT tipo, aberta_em, fechada_em FROM conferencias WHERE aberta_em >= ?', [desde])) {
    if (c.tipo === 'RONDA') { if (!naoHoje(c.fechada_em || c.aberta_em)) rondas++; continue; }
    if (c.fechada_em) { if (!naoHoje(c.fechada_em)) conferencias++; } else if (!naoHoje(c.aberta_em)) abertas++;
  }
  const aud = new Set();
  for (const e of await db.all(`SELECT ts, endereco FROM eventos WHERE tipo='CONTAGEM' AND desfeito=0 AND motivo LIKE 'Auditoria:%' AND ts >= ?`, [desde])) {
    if (!naoHoje(e.ts)) aud.add(e.endereco);
  }
  const ap = await db.get("SELECT COUNT(*) AS n FROM conferencias WHERE fechada_em IS NOT NULL AND processada_em IS NULL AND tipo <> 'RONDA'");
  return { dia, rondas, conferencias, abertas, auditorias: aud.size, a_processar: Number(ap.n) };
}

// ---------- TXT para o sistema da loja ----------
// Formato do "Importar de coletor" do sistema da loja: primeira linha com um espaço em branco e depois EAN;quantidade em cada linha.
// Vários lotes do mesmo EAN viram uma linha só (soma). Ordem alfabética do produto.
async function txtLoja(db, id) {
  const { conferencia: c, itens: lista } = await detalhe(db, id);
  const soma = new Map();
  for (const i of lista) if (i.qtd > 0) { const x = soma.get(i.ean) || { ean: i.ean, nome: i.nome, qtd: 0 }; x.qtd += i.qtd; soma.set(i.ean, x); }
  const dia = U.hojeISO(new Date(c.aberta_em));
  return { __raw: { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="conferencia-${c.id}-${c.tipo.toLowerCase()}-${dia}.txt"`, 'Cache-Control': 'no-store' },
    body: Buffer.from(' \r\n' + [...soma.values()].map(x => `${x.ean};${x.qtd}`).join('\r\n') + '\r\n', 'utf8') } };
}

// ---------- CSV ----------
const celula = v => { const s = v === null || v === undefined ? '' : String(v); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function csv(db, id) {
  const { conferencia: c, itens: lista } = await detalhe(db, id);
  const comEsperado = lista.some(i => i.esperado !== null);
  const linhas = [['EAN', 'Produto', 'Qtd', 'Lote', 'Validade', 'Endereço', ...(comEsperado ? [c.tipo === 'RONDA' ? 'Sistema' : 'Esperado'] : [])]];
  for (const i of lista) linhas.push([i.ean, i.nome || '', i.qtd, i.lote || '', U.brData(i.validade), i.endereco || '', ...(comEsperado ? [i.esperado ?? ''] : [])]);
  const dia = U.hojeISO(new Date(c.aberta_em));
  return {
    __raw: {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="conferencia-${c.id}-${c.tipo.toLowerCase()}-${dia}.csv"`, 'Cache-Control': 'no-store' },
      body: Buffer.from('﻿' + linhas.map(l => l.map(celula).join(';')).join('\r\n') + '\r\n', 'utf8'),
    },
  };
}

// Lista esperada (da nota ou da contagem do sistema da loja): cada EAN ganha uma linha com "esperado" e quantidade 0 até alguém contar.
// Depois a conferência mostra verde (igual), laranja (falta) e vermelho (passou). Vale para Recebimento e Contagem; recarregar substitui o esperado.
async function carregarEsperado(db, id, d) {
  const c = await obter(db, id);
  exigeAberta(c);
  if (!['RECEBIMENTO', 'CONTAGEM'].includes(c.tipo)) throw new HttpError(400, 'a lista esperada só vale para Recebimento e Contagem');
  const mapa = new Map(), nomes = new Map();
  for (const l of Array.isArray(d.linhas) ? d.linhas : []) {
    const ean = U.normEan(l.ean), q = Number(l.qtd);
    if (!ean || !Number.isFinite(q) || q < 0) continue;
    mapa.set(ean, (mapa.get(ean) || 0) + Math.round(q));
    if (l.nome && !nomes.has(ean)) nomes.set(ean, String(l.nome).trim().slice(0, 120));
  }
  if (!mapa.size) throw new HttpError(400, 'nenhuma linha válida para carregar');
  if (mapa.size > 3000) throw new HttpError(400, 'lista grande demais (máx. 3000 produtos)');
  const endereco = c.tipo === 'RECEBIMENTO' ? null : enderecoOuNulo(c.endereco);
  for (const [ean, nome] of nomes) if (!(await S.getProduto(db, ean))) await S.upsertProduto(db, { ean, nome });   // a nota traz o nome: cadastra uma vez
  let criados = 0, atualizados = 0;
  const agora = U.agoraISO();
  await db.tx(async t => {
    for (const [ean, q] of mapa) {
      const ex = await t.get(`SELECT id FROM conferencia_itens WHERE conferencia_id=? AND ean=? AND COALESCE(lote,'')='' AND COALESCE(validade,'')='' AND COALESCE(endereco,'')=?`, [c.id, ean, endereco || '']);
      if (ex) { await t.run('UPDATE conferencia_itens SET esperado=?, atualizado_em=? WHERE id=?', [q, agora, ex.id]); atualizados++; }
      else {
        await t.run('INSERT INTO conferencia_itens(conferencia_id, ean, qtd, lote, validade, endereco, esperado, grupos, client_id, criado_em, atualizado_em) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [c.id, ean, 0, null, null, endereco, q, '[]', `esp-${c.id}-${ean}-${Date.now()}`, agora, agora]); criados++;
      }
    }
    const nota = txt(d.nota, 40);
    if (nota) await t.run("UPDATE conferencias SET nota=? WHERE id=? AND (nota IS NULL OR nota='')", [nota, c.id]);
  });
  return { ok: true, criados, atualizados, total: mapa.size, conferencia: await obter(db, id) };
}

const ROTAS = [
  ['GET', /^\/api\/conferencias\/(\d+)\.txt$/, {}, c => txtLoja(c.db, c.m[0])],
  ['POST', /^\/api\/conferencias\/(\d+)\/processar$/, {}, c => processar(c.db, c.m[0], c.operador)],
  ['POST', /^\/api\/conferencias\/(\d+)\/esperado$/, {}, c => carregarEsperado(c.db, c.m[0], c.body)],
  ['GET', /^\/api\/conferencias$/, {}, c => listar(c.db, { tipo: c.q.get('tipo'), operador: c.q.get('operador'), data: c.q.get('data'), de: c.q.get('de'), ate: c.q.get('ate'), limite: c.q.get('limite') })],
  ['POST', /^\/api\/conferencias$/, {}, c => abrir(c.db, { ...c.body, operador: c.operador })],
  ['GET', /^\/api\/conferencias\/hoje$/, {}, c => hoje(c.db)],
  ['POST', /^\/api\/conferencias\/ronda$/, {}, c => registrarRonda(c.db, { ...c.body, operador: c.operador })],
  ['GET', /^\/api\/conferencias\/(\d+)\.csv$/, {}, c => csv(c.db, c.m[0])],
  ['GET', /^\/api\/conferencias\/(\d+)$/, {}, c => detalhe(c.db, c.m[0])],
  ['PUT', /^\/api\/conferencias\/(\d+)$/, {}, c => atualizar(c.db, c.m[0], c.body)],
  ['DELETE', /^\/api\/conferencias\/(\d+)$/, {}, c => apagar(c.db, c.m[0])],
  ['POST', /^\/api\/conferencias\/(\d+)\/fechar$/, {}, c => fechar(c.db, c.m[0], c.body && c.body.ts)],
  ['POST', /^\/api\/conferencias\/(\d+)\/itens$/, {}, c => adicionarItem(c.db, c.m[0], c.body, c.operador)],
  ['PUT', /^\/api\/conferencias\/(\d+)\/itens\/([^/]+)$/, {}, c => editarItem(c.db, c.m[0], decodeURIComponent(c.m[1]), c.body, c.operador)],
  ['DELETE', /^\/api\/conferencias\/(\d+)\/itens\/([^/]+)$/, {}, c => removerItem(c.db, c.m[0], decodeURIComponent(c.m[1]))],
];

module.exports = { ROTAS, SCHEMA, TIPOS, carregarEsperado, processar, txtLoja, abrir, atualizar, fechar, apagar, listar, obter, detalhe, itens, adicionarItem, editarItem, removerItem, registrarRonda, sincronizaRonda, hoje, csv, comparaItens };
