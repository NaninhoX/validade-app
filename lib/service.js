const crypto = require('node:crypto');
const { FAIXAS_PADRAO, ehRacao, classificar, descontoPct, estrategia } = require('./rules');
const U = require('./util');
const C = require('./causas');

const { HttpError } = U;

// ---------- configuração ----------
async function getConfig(db, chave) {
  const r = await db.get('SELECT valor FROM config WHERE chave=?', [chave]);
  if (!r) return null;
  try { return JSON.parse(r.valor); } catch { return null; }
}

async function setConfig(db, chave, valor) {
  await db.run('INSERT INTO config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor', [chave, JSON.stringify(valor)]);
}

async function getFaixas(db) {
  return (await getConfig(db, 'faixas_v2')) || FAIXAS_PADRAO;
}

async function setFaixas(db, faixas) {
  if (!Array.isArray(faixas) || faixas.length < 2) throw new HttpError(400, 'faixas inválidas');
  let ant = -Infinity;
  const limpas = faixas.map((f, i) => {
    const ultima = i === faixas.length - 1;
    if (!f.status || typeof f.status !== 'string') throw new HttpError(400, 'cada faixa precisa de status');
    if (ultima ? f.ate !== null : typeof f.ate !== 'number' || f.ate <= ant) throw new HttpError(400, 'faixas devem ter "ate" crescente e a última com ate=null');
    if (!ultima) ant = f.ate;
    for (const k of ['desconto', 'desconto_racao', 'peso']) if (typeof f[k] !== 'number' || f[k] < 0 || (k !== 'peso' && f[k] > 100)) throw new HttpError(400, `faixa ${f.status}: ${k} inválido`);
    return { ate: f.ate, status: f.status, desconto: f.desconto, desconto_racao: f.desconto_racao, peso: f.peso, cor: /^#[0-9a-f]{6}$/i.test(f.cor) ? f.cor : '#64748b' };
  });
  await setConfig(db, 'faixas_v2', limpas);
}

// Planta provisória: 19 gôndolas em 4 corredores, até o layout real da loja ser desenhado.
function layoutPadrao() {
  const gondolas = [];
  for (let i = 0; i < 19; i++) {
    const linha = Math.floor(i / 5), col = i % 5;
    gondolas.push({ id: i + 1, x: 40 + col * 190, y: 50 + linha * 120, w: 160, h: 62, rot: 0 });
  }
  return { v: 1, largura: 1000, altura: 540, gondolas, fundo: null, fundo_opacidade: 0.35, nivel_topo: 1, provisorio: true };
}

async function getLayout(db) {
  return (await getConfig(db, 'layout')) || layoutPadrao();
}

async function setLayout(db, l) {
  const num = (v, min, max, nome) => { const n = Number(v); if (!isFinite(n) || n < min || n > max) throw new HttpError(400, `layout: ${nome} inválido`); return Math.round(n * 10) / 10; };
  if (!l || !Array.isArray(l.gondolas) || l.gondolas.length > 60) throw new HttpError(400, 'layout inválido');
  // escala = pixels do mapa por centímetro: a caixa de cada gôndola vem das medidas em cm × escala (layouts antigos não têm; o editor calcula e grava)
  let escala = null;
  if (l.escala !== undefined && l.escala !== null) {
    const e = Number(l.escala);
    if (!isFinite(e) || e < 0.02 || e > 2) throw new HttpError(400, 'layout: escala inválida (use entre 0,02 e 2 px por cm)');
    escala = Math.round(e * 10000) / 10000;
  }
  const tamMin = escala ? 1 : 20;     // com escala a caixa é derivada das medidas e pode ser fina; sem escala vale o limite antigo
  const ids = new Set();
  const gondolas = l.gondolas.map(g => {
    const id = num(g.id, 1, U.GONDOLA_MAX, 'id');
    if (ids.has(id)) throw new HttpError(400, `layout: gôndola ${id} repetida`);
    ids.add(id);
    return { id, x: num(g.x, -2000, 6000, 'x'), y: num(g.y, -2000, 6000, 'y'), w: num(g.w, tamMin, 2000, 'largura'), h: num(g.h, tamMin, 2000, 'altura'), rot: [0, 90].includes(+g.rot) ? +g.rot : 0 };
  });
  // caminhos de fluxo: cada um é uma linha de 2 a 30 pontos (reta ou curva) com seta no fim; bifurcar = outro caminho que sai de um ponto
  const base = Array.isArray(l.caminhos) ? l.caminhos : (Array.isArray(l.setas) ? l.setas.map(a => {   // formato antigo (x, y, comprimento, ângulo)
    const r = (Number(a.rot) || 0) * Math.PI / 180, c = Number(a.c) || 80;
    return { curva: false, pts: [{ x: a.x, y: a.y }, { x: Number(a.x) + Math.cos(r) * c, y: Number(a.y) + Math.sin(r) * c }] };
  }) : []);
  const caminhos = base.slice(0, 40).map(c => {
    const pts = (Array.isArray(c && c.pts) ? c.pts : []).slice(0, 30);
    if (pts.length < 2) throw new HttpError(400, 'cada caminho de fluxo precisa de ao menos 2 pontos');
    return { curva: !!c.curva, pts: pts.map(p => ({ x: num(p.x, -2000, 6000, 'ponto x'), y: num(p.y, -2000, 6000, 'ponto y') })) };
  });
  let fundo = null;
  if (l.fundo) {
    if (typeof l.fundo !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(l.fundo) || l.fundo.length > 1_500_000) throw new HttpError(400, 'planta de fundo inválida ou grande demais (máx. ~1 MB)');
    fundo = l.fundo;
  }
  const limpo = {
    v: 1, largura: num(l.largura, 400, 4000, 'largura'), altura: num(l.altura, 300, 4000, 'altura'), ...(escala ? { escala } : {}), gondolas, caminhos, fundo,
    fundo_opacidade: num(l.fundo_opacidade ?? 0.35, 0, 1, 'opacidade'), nivel_topo: +l.nivel_topo === U.NIVEIS_MAX ? U.NIVEIS_MAX : 1, provisorio: false,
  };
  await setConfig(db, 'layout', limpo);
  return limpo;
}

// ---------- setores: nome e responsáveis de cada lado de cada gôndola ----------
// { "7": { "A": { nome: "Higiene", resp: ["DAVI"] }, "B": {...}, "F": {...}, "C": {...} } }   (nas gôndolas 9 e 10 as pontas são PE/PD)
async function getSetores(db) {
  return (await getConfig(db, 'setores')) || {};
}

async function setSetores(db, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'setores inválidos');
  const nomes = new Set((await db.all('SELECT nome FROM usuarios')).map(u => u.nome));
  const limpo = {};
  for (const [g, lados] of Object.entries(r)) {
    const id = Number(g);
    if (!Number.isInteger(id) || id < 1 || id > U.GONDOLA_MAX) throw new HttpError(400, `gôndola ${g} inválida`);
    if (!lados || typeof lados !== 'object') throw new HttpError(400, `gôndola ${g}: setores inválidos`);
    for (const [lado, s] of Object.entries(lados)) {
      if (!U.lados(id).includes(lado)) throw new HttpError(400, `gôndola ${id}: lado ${lado} não existe`);
      const nome = String((s && s.nome) || '').trim().slice(0, 40);
      const lista = Array.isArray(s && s.resp) ? [...new Set(s.resp.map(n => String(n).trim().toUpperCase()).filter(Boolean))] : [];
      if (lista.length > 6) throw new HttpError(400, `gôndola ${id}-${lado}: responsáveis demais`);
      for (const n of lista) if (!nomes.has(n)) throw new HttpError(400, `usuário ${n} não existe`);
      if (nome || lista.length) (limpo[id] = limpo[id] || {})[lado] = { nome, resp: lista };
    }
  }
  await setConfig(db, 'setores', limpo);
  return limpo;
}

// ---------- configuração de cada gôndola (lados, módulos, medidas, nomes; sacaria = área com pallets) ----------
// { "7": { lados: "AB"|"A"|"B", modulos: 5, dim: { modulo_c, modulo_l, ponta_c, ponta_p } | null, nomes: { "B-1": "Fantasia" } },
//   "19": { tipo: "area", c: 600, l: 400, pallets: [{ id: 1, x: 10, y: 10, c: 120, l: 100, nome: "" }] } }
// Quais gôndolas são áreas livres (com pallets): as marcadas assim, mais a 19 enquanto não for configurada de outro jeito.
const areasDe = cfg => { const s = new Set([19]); for (const [g, c] of Object.entries(cfg || {})) { if (c.tipo === 'area') s.add(+g); else if (c.tipo === 'gondola') s.delete(+g); } return [...s]; };
let areasEm = 0;
async function sincronizaAreas(db) {   // mantém o validador de endereços alinhado à configuração (com cache curto)
  if (Date.now() - areasEm < 5000) return;
  U.setAreas(areasDe(await getConfig(db, 'gondolas_cfg')));
  areasEm = Date.now();
}

async function getGondolasCfg(db) {
  return (await getConfig(db, 'gondolas_cfg')) || {};
}

async function setGondolasCfg(db, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'configuração das gôndolas inválida');
  const faixa = (v, min, max, nome) => { const n = Number(v); if (!isFinite(n) || n < min || n > max) throw new HttpError(400, `${nome}: use entre ${min} e ${max}`); return Math.round(n * 10) / 10; };
  const limpo = {};
  for (const [g, c] of Object.entries(r)) {
    const id = Number(g);
    if (!Number.isInteger(id) || id < 1 || id > U.GONDOLA_MAX) throw new HttpError(400, `gôndola ${g} inválida`);
    if (!c || typeof c !== 'object') continue;
    const tipo = c.tipo === 'area' || c.tipo === 'gondola' ? c.tipo : (id === 19 ? 'area' : 'gondola');
    const nomeG = String(c.nome || '').trim().slice(0, 40);
    if (tipo === 'area') {
      const pallets = (Array.isArray(c.pallets) ? c.pallets : []).slice(0, 40);
      const ids = new Set();
      limpo[id] = { tipo: 'area', nome: nomeG, c: faixa(c.c ?? 600, 100, 3000, 'comprimento da área'), l: faixa(c.l ?? 400, 100, 3000, 'largura da área'),
        pallets: pallets.map((p, i) => {
          const pid = Number(p.id) || i + 1;
          if (!Number.isInteger(pid) || pid < 1 || pid > 40 || ids.has(pid)) throw new HttpError(400, `pallet ${p.id}: número inválido ou repetido`);
          ids.add(pid);
          return { id: pid, x: faixa(p.x ?? 0, 0, 3000, 'pallet x'), y: faixa(p.y ?? 0, 0, 3000, 'pallet y'), c: faixa(p.c ?? 120, 20, 600, 'pallet comprimento'), l: faixa(p.l ?? 100, 20, 600, 'pallet largura'), nome: String(p.nome || '').trim().slice(0, 40) };
        }) };
      continue;
    }
    const lados = ['AB', 'A', 'B'].includes(c.lados) ? c.lados : 'AB';
    const modulos = Number.isInteger(+c.modulos) && c.modulos >= 1 && c.modulos <= U.NIVEIS_MAX ? +c.modulos : 5;
    let dim = null;
    if (c.dim && typeof c.dim === 'object') {
      const lim = { modulo_c: [40, 300], modulo_l: [20, 100], ponta_c: [40, 300], ponta_p: [10, 100] };
      dim = {};
      for (const [k, [min, max]] of Object.entries(lim)) if (c.dim[k] !== undefined && c.dim[k] !== null && c.dim[k] !== '') dim[k] = faixa(c.dim[k], min, max, `gôndola ${id}: ${k}`);
      if (!Object.keys(dim).length) dim = null;
    }
    const nomes = {};
    for (const [k, v] of Object.entries(c.nomes && typeof c.nomes === 'object' ? c.nomes : {})) {
      const m = k.match(/^([AB])-(\d{1,2})$/);
      if (!m || !lados.includes(m[1]) || +m[2] < 1 || +m[2] > modulos) throw new HttpError(400, `gôndola ${id}: módulo ${k} não existe`);
      const t = String(v || '').trim().slice(0, 40);
      if (t) nomes[k] = t;
    }
    limpo[id] = { tipo: 'gondola', nome: nomeG, frente: c.frente === 'E' || c.frente === 'D' ? c.frente : null, lados, modulos, dim, nomes };
  }
  await setConfig(db, 'gondolas_cfg', limpo);
  U.setAreas(areasDe(limpo)); areasEm = Date.now();
  return limpo;
}

// Medidas reais (cm) usadas para desenhar as gôndolas em escala. Editáveis em Configurações.
const DIMENSOES_PADRAO = { modulo_c: 140, modulo_l: 40, ponta_c: 100, ponta_p: 40 };
async function getDimensoes(db) {
  return { ...DIMENSOES_PADRAO, ...((await getConfig(db, 'dimensoes')) || {}) };
}
async function setDimensoes(db, d) {
  const lim = { modulo_c: [40, 300], modulo_l: [20, 100], ponta_c: [40, 300], ponta_p: [10, 100] };
  const novo = {};
  for (const [k, [min, max]] of Object.entries(lim)) {
    const n = Number(d && d[k]);
    if (!isFinite(n) || n < min || n > max) throw new HttpError(400, `medida ${k}: use entre ${min} e ${max} cm`);
    novo[k] = Math.round(n);
  }
  await setConfig(db, 'dimensoes', novo);
  return novo;
}

// Avisa no recebimento quando o lote já chega com menos dias que isso (0 = não avisa).
const VALIDADE_MINIMA_PADRAO = 90;
async function getValidadeMinima(db) {
  const v = await getConfig(db, 'validade_minima');
  return Number.isInteger(v) ? v : VALIDADE_MINIMA_PADRAO;
}
async function setValidadeMinima(db, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 365) throw new HttpError(400, 'validade mínima: use de 0 a 365 dias');
  await setConfig(db, 'validade_minima', n);
  return n;
}

// Placar por responsável: o que está nos setores (gôndola + lado) de cada um + o que cada um conferiu na ronda nos últimos 7 dias.
async function placar(db) {
  const desde = new Date(Date.now() - 8 * 864e5).toISOString();
  const [m, evs] = await Promise.all([mapa(db), db.all(`SELECT operador, motivo FROM eventos WHERE ts >= ? AND desfeito=0 AND historico=0 AND motivo LIKE 'Ronda:%'`, [desde])]);
  const porG = new Map(m.gondolas.map(g => [g.id, g]));
  const ronda7 = new Map();
  for (const e of evs) {
    const r = ronda7.get(e.operador) || { lotes: 0, divergentes: 0 };
    r.lotes++; if (!e.motivo.startsWith('Ronda: confere')) r.divergentes++;
    ronda7.set(e.operador, r);
  }
  const pessoas = new Map();
  for (const [g, lados] of Object.entries(m.setores)) {
    const d = porG.get(+g);
    for (const [lado, s] of Object.entries(lados)) {
      for (const nome of s.resp) {
        const p = pessoas.get(nome) || { nome, setores: [], lotes: 0, vencidos: 0, risco: 0, nunca_contadas: 0, pior_dias_sem_ronda: null };
        p.setores.push(`${g}-${lado}`);
        for (const c of d ? d.celulas.filter(x => x.lado === lado) : []) {
          p.lotes += c.lotes; p.vencidos += c.vencidos; p.risco += c.risco;
          if (c.dias_sem_ronda === null || c.dias_sem_ronda === undefined) p.nunca_contadas++;
          else if (p.pior_dias_sem_ronda === null || c.dias_sem_ronda > p.pior_dias_sem_ronda) p.pior_dias_sem_ronda = c.dias_sem_ronda;
        }
        pessoas.set(nome, p);
      }
    }
  }
  return [...pessoas.values()].map(p => {
    const r = ronda7.get(p.nome) || { lotes: 0, divergentes: 0 };
    return { ...p, risco: +p.risco.toFixed(2), ronda7_lotes: r.lotes, ronda7_divergencia: r.lotes ? +(r.divergentes / r.lotes * 100).toFixed(1) : null };
  }).sort((a, b) => b.risco - a.risco || b.vencidos - a.vencidos);
}

// ---------- enriquecimento ----------
// Regra conservadora: se unidades de um lote mais curto foram parar em outra caixa (ou o lote sumiu da prateleira), o alerta vale pela validade mais curta.
const validadeEfetiva = row => (row.validade_alerta && row.validade_alerta < row.validade ? row.validade_alerta : row.validade);

function enrich(row, faixas, hoje) {
  const valEf = validadeEfetiva(row);
  const dias = U.diasAte(valEf, hoje);
  const f = classificar(dias, faixas);
  const racao = ehRacao(row.nome, row.categoria);
  const pct = descontoPct(f, racao);
  const preco = row.preco ?? null;
  const valor = preco !== null ? +(preco * row.qtd).toFixed(2) : null;
  const fracao = f.ate === 0 ? 1 : pct / 100;
  const p = U.parseEndereco(row.endereco);
  return {
    ...row,
    gondola: p.gondola !== undefined ? String(p.gondola) : '',
    endereco_ok: p.valido,
    validade_efetiva: valEf, misto: valEf !== row.validade, a_confirmar: !!row.validade_confirmar,
    dias,
    status: f.status,
    cor: f.cor,
    racao,
    desconto: pct,
    estrategia: estrategia(f, pct),
    peso: f.peso,
    valor,
    perda: valor !== null ? +(valor * fracao).toFixed(2) : null,
    preco_desc: preco !== null && pct > 0 ? +(preco * (1 - pct / 100)).toFixed(2) : null,
    etiquetado: pct > 0 && row.acao === rotuloEtiqueta(pct),
    etiquetar: pct > 0 && f.ate !== 0 && row.acao !== rotuloEtiqueta(pct),
  };
}

const SEL_LOTES = `
  SELECT l.id, l.ean, l.lote, l.validade, l.endereco, l.qtd, l.acao, l.atualizado_em, l.validade_alerta, l.validade_confirmar,
         p.nome, p.preco, p.preco_em, p.preco_por, p.marca, p.categoria
  FROM lotes l LEFT JOIN produtos p ON p.ean = l.ean`;

async function lotesAtivos(db, { q, endereco, gondola, marca } = {}) {
  const where = ['l.qtd > 0'];
  const args = [];
  if (q) {
    where.push('(l.ean ILIKE ? OR p.nome ILIKE ? OR l.lote ILIKE ? OR l.endereco ILIKE ? OR p.marca ILIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  if (endereco) { where.push('l.endereco = ?'); args.push(U.normEndereco(endereco)); }
  if (marca) { where.push('p.marca = ?'); args.push(marca); }
  const [faixas, linhas] = await Promise.all([getFaixas(db), db.all(`${SEL_LOTES} WHERE ${where.join(' AND ')} ORDER BY l.validade, l.id`, args)]);
  const hoje = U.hojeISO();
  let rows = linhas.map(r => enrich(r, faixas, hoje));
  if (gondola) rows = rows.filter(r => r.gondola === String(gondola));
  return rows;
}

// Ordenação do Estoque por coluna (vazios sempre no fim; empate pela validade). Sem `ordem` conhecida, devolve como veio.
const ORDENS = { status: r => r.dias, produto: r => r.nome || '', lote: r => r.lote, qtd: r => r.qtd, validade: r => r.validade, dias: r => r.dias, endereco: r => r.endereco || '', preco: r => r.preco, oferta: r => r.desconto || 0 };
function ordenaLotes(rows, ordem, dir) {
  const f = ORDENS[ordem];
  if (!f) return rows;
  const sinal = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = f(a), y = f(b), nx = x === null || x === undefined || x === '', ny = y === null || y === undefined || y === '';
    if (nx || ny) { if (nx && ny) return 0; return nx ? 1 : -1; }
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR', { numeric: true, sensitivity: 'base' });
    return cmp * sinal || (a.validade < b.validade ? -1 : a.validade > b.validade ? 1 : a.id - b.id);
  });
}

// Preço antigo: sem data de conferência ou conferido há mais de PRECO_ANTIGO_DIAS dias.
const PRECO_ANTIGO_DIAS = 60;
const diasDoPreco = (row, hoje = U.hojeISO()) => (row.preco_em ? Math.max(0, U.diasAte(hoje, U.hojeISO(new Date(row.preco_em)))) : null);
const precoAntigo = (row, hoje) => { const d = diasDoPreco(row, hoje); return d === null || d > PRECO_ANTIGO_DIAS; };

// Estoque por produto: cada EAN vira um grupo com seus lotes (os filtros já foram aplicados aos lotes).
function agrupaPorProduto(rows, hoje = U.hojeISO()) {
  const m = new Map();
  for (const l of rows) {
    let g = m.get(l.ean);
    if (!g) { g = { ean: l.ean, nome: l.nome || null, marca: l.marca || null, categoria: l.categoria || null, preco: l.preco ?? null, preco_em: l.preco_em || null, preco_por: l.preco_por || null, preco_dias: diasDoPreco(l, hoje),
      qtd: 0, valor: null, dias_min: null, validade_min: null, status: null, cor: null, peso: -1, lotes: [] }; m.set(l.ean, g); }
    g.lotes.push(l); g.qtd += l.qtd;
    if (l.valor !== null && l.valor !== undefined) g.valor = +((g.valor || 0) + l.valor).toFixed(2);
    if (g.dias_min === null || l.dias < g.dias_min) { g.dias_min = l.dias; g.validade_min = l.validade_efetiva || l.validade; g.status = l.status; g.cor = l.cor; g.peso = l.peso; }
  }
  return [...m.values()];
}
const ORDENS_G = { produto: g => g.nome || '', status: g => g.dias_min, dias: g => g.dias_min, validade: g => g.validade_min, lotes: g => g.lotes.length, qtd: g => g.qtd, preco: g => g.preco, atualizado: g => (g.preco_dias === null ? 1e9 : g.preco_dias), valor: g => g.valor };
function ordenaGrupos(gs, ordem, dir) {
  const f = ORDENS_G[ordem] || ORDENS_G.dias, sinal = ORDENS_G[ordem] && dir === 'desc' ? -1 : 1;
  return [...gs].sort((a, b) => {
    const x = f(a), y = f(b), nx = x === null || x === undefined || x === '', ny = y === null || y === undefined || y === '';
    if (nx || ny) { if (nx && ny) return 0; return nx ? 1 : -1; }
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR', { numeric: true, sensitivity: 'base' });
    return cmp * sinal || a.dias_min - b.dias_min || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
  });
}

// ---------- produtos ----------
async function getProduto(db, eanRaw) {
  const ean = U.normEan(eanRaw);
  if (!ean) return null;
  return (await db.get('SELECT * FROM produtos WHERE ean = ?', [ean]))
    || (await db.get('SELECT * FROM produtos WHERE ean_key = ? ORDER BY length(ean) DESC', [U.eanKey(ean)]))
    || null;
}

async function upsertProduto(db, d) {
  const ean = U.normEan(d.ean);
  if (!ean) throw new HttpError(400, 'EAN inválido');
  const nome = (d.nome || '').toString().trim();
  if (!nome) throw new HttpError(400, 'informe o nome do produto');
  const preco = U.parsePreco(d.preco);
  if (preco !== null && (!isFinite(preco) || preco < 0)) throw new HttpError(400, 'preço inválido');
  const atual = await getProduto(db, ean);
  const agora = U.agoraISO(), por = d.operador || null;
  if (atual) {
    // preço mudado ou conferido de propósito (confirmar) atualiza a data; carga em lote com o mesmo preço não conta como conferência
    const mudou = preco !== null && preco !== atual.preco;
    const fixa = mudou || (preco !== null && d.confirmar === true);
    const sets = ['nome=?', 'preco=COALESCE(?,preco)', 'marca=COALESCE(?,marca)', 'categoria=COALESCE(?,categoria)'];
    const args = [nome, preco, d.marca || null, d.categoria || null];
    if (fixa) { sets.push('preco_em=?', 'preco_por=?'); args.push(agora, por); }
    await db.run(`UPDATE produtos SET ${sets.join(', ')} WHERE ean=?`, [...args, atual.ean]);
    if (mudou) await db.run('INSERT INTO precos_historico(ean, preco_antes, preco_depois, por, em) VALUES(?,?,?,?,?)', [atual.ean, atual.preco ?? null, preco, por, agora]);
    return getProduto(db, atual.ean);
  }
  await db.run('INSERT INTO produtos(ean, ean_key, nome, preco, marca, categoria, preco_em, preco_por) VALUES(?,?,?,?,?,?,?,?)',
    [ean, U.eanKey(ean), nome, preco, d.marca || null, d.categoria || null, preco === null ? null : agora, preco === null ? null : por]);
  return getProduto(db, ean);
}

const historicoPrecos = (db, eanRaw) => db.all('SELECT preco_antes, preco_depois, por, em FROM precos_historico WHERE ean = ? ORDER BY id DESC LIMIT 30', [U.normEan(eanRaw) || String(eanRaw)]);

async function infoProduto(db, eanRaw) {
  const p = await getProduto(db, eanRaw);
  if (!p) return { cadastrado: false, ean: U.normEan(eanRaw), lotes: [] };
  const lotes = (await lotesAtivos(db)).filter(l => l.ean === p.ean);
  return { cadastrado: true, produto: p, lotes };
}

// ---------- leituras (entrada de dados) ----------
const TIPOS = ['RECEBIMENTO', 'CONTAGEM', 'AJUSTE', 'BAIXA', 'TRANSFERENCIA', 'ETIQUETA'];
const MOTIVOS_BAIXA = ['Venda', 'RMA', 'Avaria', 'Furto', 'Retirada Preventiva', 'Doação', 'Outro'];

const rotuloEtiqueta = pct => `Etiquetado ${pct}%`;

function inteiro(v, nome, { min = 0 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${nome} inválida`);
  return n;
}

async function aplicar(t, { ts, tipo, lote, delta, novaQtd, operador, motivo, causa, obs, client_id, grupo, historico = 0 }) {
  const antes = lote.qtd;
  const depois = novaQtd !== undefined ? novaQtd : antes + delta;
  if (depois < 0) throw new HttpError(409, `saldo insuficiente (saldo atual: ${antes})`);
  await t.run('UPDATE lotes SET qtd=?, atualizado_em=?, validade_alerta=CASE WHEN ? = 0 THEN NULL ELSE validade_alerta END WHERE id=?', [depois, ts, depois, lote.id]);
  await t.run(`INSERT INTO eventos(ts,tipo,lote_id,ean,lote,validade,endereco,delta,qtd_antes,qtd_depois,operador,motivo,obs,client_id,grupo,historico,causa)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ts, tipo, lote.id, lote.ean, lote.lote, lote.validade, lote.endereco, depois - antes, antes, depois, operador, motivo || null, obs || null, client_id || null, grupo, historico, causa || null]);
  lote.qtd = depois;
}

// cria o lote se não existir e já o trava (FOR UPDATE) até o fim da transação, para dois aparelhos não se atropelarem
async function acharOuCriarLote(t, ean, lote, validade, endereco, ts) {
  await t.run('INSERT INTO lotes(ean,lote,validade,endereco,qtd,atualizado_em) VALUES(?,?,?,?,0,?) ON CONFLICT (ean,lote,validade,endereco) DO NOTHING', [ean, lote, validade, endereco, ts]);
  return t.get('SELECT * FROM lotes WHERE ean=? AND lote=? AND validade=? AND endereco=? FOR UPDATE', [ean, lote, validade, endereco]);
}

// Recebimento com validade ilegível: entra com a validade mais curta já vista do produto (ou 30 dias) e fica marcado "a confirmar".
async function validadeProvisoria(t, ean) {
  const r = await t.get('SELECT MIN(validade) AS v FROM lotes WHERE ean=? AND qtd>0', [ean]);
  const hoje = U.hojeISO();
  return r && r.v && r.v >= hoje ? r.v : U.hojeISO(new Date(Date.now() + 30 * 864e5));
}

// Um lote contado como "não achei" pode ter sido passado para outra caixa do mesmo produto: os que ficam no endereço passam a valer pela validade dele.
async function propagaSumico(t, lote) {
  const v = validadeEfetiva(lote);
  if (v < U.hojeISO()) return;                       // lote já vencido que sumiu: não contamina os outros
  const outros = await t.all('SELECT id, validade, validade_alerta FROM lotes WHERE ean=? AND endereco=? AND qtd>0 AND id<>? AND validade>?', [lote.ean, lote.endereco, lote.id, v]);
  for (const o of outros) if (v < validadeEfetiva(o)) await t.run('UPDATE lotes SET validade_alerta=? WHERE id=?', [v, o.id]);
}

async function avisos(t, l, tipo, qtd) {
  const w = [];
  const dias = U.diasAte(l.validade);
  if (dias < 0 && ['RECEBIMENTO', 'CONTAGEM', 'AJUSTE'].includes(tipo)) w.push(`Validade já vencida há ${-dias} dia(s)`);
  if (dias > 365 * 5) w.push('Validade a mais de 5 anos — confira o ano digitado');
  if (qtd > 300) w.push(`Quantidade alta (${qtd}) — confira`);
  if (tipo === 'RECEBIMENTO' && dias > 0) {
    const min = await getValidadeMinima(t);
    if (min && dias < min) w.push(`Lote chegou com só ${dias} dia(s) de validade (mínimo da loja: ${min}) — confira com o CD`);
  }
  if (['RECEBIMENTO', 'CONTAGEM'].includes(tipo)) {
    const outros = await t.all('SELECT lote, validade, qtd FROM lotes WHERE ean=? AND endereco=? AND qtd>0 AND id<>? ORDER BY validade', [l.ean, l.endereco, l.id]);
    const maisNovos = outros.filter(o => o.validade > l.validade);
    if (maisNovos.length) w.push(`FEFO: este lote vence ANTES do lote ${maisNovos[0].lote} (${U.brData(maisNovos[0].validade)}) que já está aqui — coloque na frente`);
    const outraVal = await t.all('SELECT DISTINCT validade FROM lotes WHERE ean=? AND lote=? AND validade<>? AND qtd>0', [l.ean, l.lote, l.validade]);
    if (outraVal.length) w.push(`O lote ${l.lote} já existe com validade ${U.brData(outraVal[0].validade)} — confira`);
  }
  return w;
}

async function leituraTx(db, d) {
  const res = await db.tx(async t => {
    if (d.client_id) {
      const ex = await t.get('SELECT grupo FROM eventos WHERE client_id = ?', [String(d.client_id)]);
      if (ex) return { ok: true, duplicado: true, grupo: ex.grupo, avisos: [] };
    }
    const tipo = String(d.tipo || '').toUpperCase();
    if (!TIPOS.includes(tipo)) throw new HttpError(400, `tipo deve ser um de ${TIPOS.join(', ')}`);
    const operador = String(d.operador || '').trim();
    if (!operador) throw new HttpError(400, 'informe o operador');
    const ts = d.ts && !isNaN(Date.parse(d.ts)) ? new Date(d.ts).toISOString() : U.agoraISO();
    const grupo = crypto.randomUUID();
    const obs = d.obs ? String(d.obs).slice(0, 300) : null;
    const client_id = d.client_id ? String(d.client_id) : null;

    let lote, confirmar = 0;
    if (d.lote_id) {
      lote = await t.get('SELECT * FROM lotes WHERE id=? FOR UPDATE', [Number(d.lote_id)]);
      if (!lote) throw new HttpError(404, 'lote não encontrado');
    } else {
      let p = await getProduto(t, d.ean);
      const ean = p ? p.ean : U.normEan(d.ean);
      if (!ean) throw new HttpError(400, 'EAN inválido');
      if (!p) {
        if (!d.nome) throw new HttpError(422, 'EAN não cadastrado — informe o nome para cadastrar');
        p = await upsertProduto(t, { ean, nome: d.nome, preco: d.preco });
      } else if (d.preco !== undefined && d.preco !== null && String(d.preco).trim() !== '') {
        p = await upsertProduto(t, { ean: p.ean, nome: p.nome, preco: d.preco });   // preço informado na contagem
      }
      let validade = U.parseData(d.validade);
      if (!validade && tipo === 'RECEBIMENTO' && d.validade_confirmar) { validade = await validadeProvisoria(t, ean); confirmar = 1; }
      if (!validade) throw new HttpError(400, 'validade inválida');
      const endereco = U.normEndereco(d.endereco);
      if (tipo !== 'BAIXA') {
        if (!endereco && !d.sem_endereco) throw new HttpError(400, 'informe o endereço (gôndola-lado-prateleira)');   // sem_endereco: importação da folha de papel
        const e = endereco ? U.erroEndereco(endereco) : null;
        if (e) throw new HttpError(400, e);
      }
      const nomeLote = U.normLote(d.lote);
      lote = tipo === 'BAIXA'
        ? await t.get('SELECT * FROM lotes WHERE ean=? AND lote=? AND validade=? AND endereco=? FOR UPDATE', [ean, nomeLote, validade, endereco])
        : await acharOuCriarLote(t, ean, nomeLote, validade, endereco, ts);
      if (!lote) throw new HttpError(404, 'lote não encontrado para dar baixa');
      if (confirmar) await t.run('UPDATE lotes SET validade_confirmar=1 WHERE id=?', [lote.id]);
    }

    let qtdAviso = 0;
    if (tipo === 'RECEBIMENTO') {
      const q = inteiro(d.qtd, 'quantidade', { min: 1 });
      qtdAviso = q;
      await aplicar(t, { ts, tipo, lote, delta: q, operador, motivo: d.motivo, obs, client_id, grupo });
    } else if (tipo === 'CONTAGEM' || tipo === 'AJUSTE') {
      const q = inteiro(d.qtd, 'quantidade', { min: 0 });
      qtdAviso = q;
      const antes = lote.qtd;
      await aplicar(t, { ts, tipo, lote, novaQtd: q, operador, motivo: d.motivo, obs, client_id, grupo });
      if (tipo === 'CONTAGEM' && antes > 0 && q === 0) await propagaSumico(t, lote);
    } else if (tipo === 'BAIXA') {
      const q = inteiro(d.qtd, 'quantidade', { min: 1 });
      if (!d.motivo || !MOTIVOS_BAIXA.includes(d.motivo)) throw new HttpError(400, `motivo da baixa: ${MOTIVOS_BAIXA.join(', ')}`);
      const causa = C.validarCausa(d.motivo, d.causa);
      await aplicar(t, { ts, tipo, lote, delta: -q, operador, motivo: d.motivo, causa, obs, client_id, grupo });
    } else if (tipo === 'ETIQUETA') {
      // registra que o operador colou a etiqueta de desconto neste lote (não mexe no saldo)
      if (!d.lote_id) throw new HttpError(400, 'informe o lote');
      const pct = inteiro(d.desconto, 'desconto', { min: 1 });
      if (pct > 100) throw new HttpError(400, 'desconto inválido');
      const rotulo = rotuloEtiqueta(pct);
      await aplicar(t, { ts, tipo, lote, delta: 0, operador, motivo: rotulo, obs, client_id, grupo });
      await t.run('UPDATE lotes SET acao=? WHERE id=?', [rotulo, lote.id]);
      lote.acao = rotulo;
    } else if (tipo === 'TRANSFERENCIA') {
      const q = inteiro(d.qtd, 'quantidade', { min: 1 });
      const destino = U.normEndereco(d.endereco_destino);
      if (!destino) throw new HttpError(400, 'informe o endereço de destino');
      const e = U.erroEndereco(destino);
      if (e) throw new HttpError(400, e);
      if (destino === lote.endereco) throw new HttpError(400, 'destino igual à origem');
      await aplicar(t, { ts, tipo: 'TRANSF_SAIDA', lote, delta: -q, operador, motivo: destino, obs, client_id, grupo });
      const dest = await acharOuCriarLote(t, lote.ean, lote.lote, lote.validade, destino, ts);
      await aplicar(t, { ts, tipo: 'TRANSF_ENTRADA', lote: dest, delta: q, operador, motivo: lote.endereco, obs, grupo });
      lote = dest;
    }
    const atual = await t.get('SELECT * FROM lotes WHERE id=?', [lote.id]);
    const w = await avisos(t, atual, tipo, qtdAviso);
    const p = await getProduto(t, atual.ean);
    return { ok: true, grupo, avisos: w, _lote: { ...atual, nome: p?.nome, preco: p?.preco, marca: p?.marca, categoria: p?.categoria } };
  });
  if (res._lote) { res.lote = enrich(res._lote, await getFaixas(db), U.hojeISO()); delete res._lote; }
  return res;
}

// Dois aparelhos criando o mesmo lote ao mesmo tempo (ou reenviando o mesmo lançamento) podem bater na chave única: tenta de novo uma vez.
async function leitura(db, d) {
  try { return await leituraTx(db, d); }
  catch (e) { if (e && e.code === '23505') return leituraTx(db, d); throw e; }
}

// "Completei outra caixa": parte de um lote foi para outra caixa do mesmo produto; o destino passa a valer pela validade mais curta.
async function misturar(db, d) {
  const q = inteiro(d.qtd, 'quantidade', { min: 1 });
  const operador = String(d.operador || '').trim();
  if (!operador) throw new HttpError(400, 'informe o operador');
  return db.tx(async t => {
    const o = await t.get('SELECT * FROM lotes WHERE id=? FOR UPDATE', [Number(d.origem_id)]);
    const de = await t.get('SELECT * FROM lotes WHERE id=? FOR UPDATE', [Number(d.destino_id)]);
    if (!o || !de) throw new HttpError(404, 'lote não encontrado');
    if (o.id === de.id) throw new HttpError(400, 'origem e destino são o mesmo lote');
    if (o.ean !== de.ean) throw new HttpError(400, 'os lotes são de produtos diferentes');
    const ts = U.agoraISO(), grupo = crypto.randomUUID();
    await aplicar(t, { ts, tipo: 'MISTURA_SAIDA', lote: o, delta: -q, operador, motivo: 'completou o lote ' + de.lote, grupo });
    await aplicar(t, { ts, tipo: 'MISTURA_ENTRADA', lote: de, delta: q, operador, motivo: 'veio do lote ' + o.lote, grupo });
    const v = validadeEfetiva(o);
    if (v >= U.hojeISO() && v < validadeEfetiva(de)) await t.run('UPDATE lotes SET validade_alerta=? WHERE id=?', [v, de.id]);
    return { ok: true, grupo, validade_alerta: v < validadeEfetiva(de) ? v : validadeEfetiva(de) };
  });
}

// Confirma a validade de um lote que entrou "a confirmar". Se já existir o mesmo lote com essa validade, as unidades se juntam a ele.
async function confirmarValidade(db, d) {
  const nova = U.parseData(d.validade);
  if (!nova) throw new HttpError(400, 'validade inválida');
  const operador = String(d.operador || '').trim();
  if (!operador) throw new HttpError(400, 'informe o operador');
  return db.tx(async t => {
    const l = await t.get('SELECT * FROM lotes WHERE id=? FOR UPDATE', [Number(d.lote_id)]);
    if (!l) throw new HttpError(404, 'lote não encontrado');
    if (!l.validade_confirmar) throw new HttpError(400, 'este lote não está marcado como validade a confirmar');
    const ts = U.agoraISO(), grupo = crypto.randomUUID();
    const igual = await t.get('SELECT * FROM lotes WHERE ean=? AND lote=? AND validade=? AND endereco=? AND id<>? FOR UPDATE', [l.ean, l.lote, nova, l.endereco, l.id]);
    if (igual) {
      const q = l.qtd;
      await aplicar(t, { ts, tipo: 'AJUSTE', lote: l, delta: -q, operador, motivo: 'Validade confirmada (juntou ao lote existente)', grupo });
      await aplicar(t, { ts, tipo: 'AJUSTE', lote: igual, delta: q, operador, motivo: 'Validade confirmada (veio do lote a confirmar)', grupo });
      await t.run('UPDATE lotes SET validade_confirmar=0 WHERE id=?', [l.id]);
      return { ok: true, grupo, lote_id: igual.id };
    }
    await t.run('UPDATE lotes SET validade=?, validade_confirmar=0, validade_alerta=NULL, atualizado_em=? WHERE id=?', [nova, ts, l.id]);
    l.validade = nova;
    await aplicar(t, { ts, tipo: 'AJUSTE', lote: l, delta: 0, operador, motivo: 'Validade confirmada', grupo });
    return { ok: true, grupo, lote_id: l.id };
  });
}

// Contagem só por EAN no endereço (sem dizer o lote): se faltar produto, a falta é atribuída ao lote de validade mais LONGA,
// para os lotes que vencem primeiro continuarem aparecendo nos alertas até alguém conferir.
async function ajusteTotal(db, d) {
  const ean = U.normEan(d.ean), endereco = U.normEndereco(d.endereco);
  if (!ean || !endereco) throw new HttpError(400, 'informe o EAN e o endereço');
  const total = inteiro(d.qtd_total, 'quantidade', { min: 0 });
  const operador = String(d.operador || '').trim();
  if (!operador) throw new HttpError(400, 'informe o operador');
  return db.tx(async t => {
    const lotes = await t.all('SELECT * FROM lotes WHERE ean=? AND endereco=? AND qtd>0 ORDER BY validade DESC, id FOR UPDATE', [ean, endereco]);
    const soma = lotes.reduce((s, l) => s + l.qtd, 0);
    if (total > soma) throw new HttpError(409, 'há mais produto do que o sistema tem (' + soma + '): informe o lote para lançar a diferença');
    let falta = soma - total; const ts = U.agoraISO(), grupo = crypto.randomUUID(), ajustes = [];
    for (const l of lotes) {
      if (!falta) break;
      const tira = Math.min(l.qtd, falta);
      await aplicar(t, { ts, tipo: 'CONTAGEM', lote: l, novaQtd: l.qtd - tira, operador, motivo: 'Contagem por EAN: falta atribuída ao lote de validade mais longa', grupo });
      ajustes.push({ lote_id: l.id, lote: l.lote, validade: l.validade, tirou: tira }); falta -= tira;
    }
    return { ok: true, grupo, antes: soma, depois: total, ajustes };
  });
}

async function desfazer(db, grupo) {
  return db.tx(async t => {
    const evs = await t.all('SELECT * FROM eventos WHERE grupo=? AND desfeito=0 AND historico=0 ORDER BY id DESC', [String(grupo)]);
    if (!evs.length) throw new HttpError(404, 'nada para desfazer neste lançamento');
    for (const e of evs) {
      const l = await t.get('SELECT * FROM lotes WHERE id=? FOR UPDATE', [e.lote_id]);
      if (!l) continue;
      const novo = l.qtd - e.delta;
      if (novo < 0) throw new HttpError(409, 'não dá para desfazer: o saldo já mudou depois deste lançamento');
      await t.run('UPDATE lotes SET qtd=?, atualizado_em=? WHERE id=?', [novo, U.agoraISO(), l.id]);
      await t.run('UPDATE eventos SET desfeito=1 WHERE id=?', [e.id]);
      if (e.tipo === 'ETIQUETA' && l.acao === e.motivo) {   // volta para a etiqueta anterior, se houver
        const ant = await t.get(`SELECT motivo FROM eventos WHERE lote_id=? AND tipo='ETIQUETA' AND desfeito=0 ORDER BY id DESC LIMIT 1`, [l.id]);
        await t.run('UPDATE lotes SET acao=? WHERE id=?', [ant ? ant.motivo : null, l.id]);
      }
    }
    return { ok: true, desfeitos: evs.length };
  });
}

// ---------- consultas ----------
const ultimasContagens = async db => new Map((await db.all(`SELECT endereco, MAX(ts) ts FROM eventos WHERE tipo IN ('CONTAGEM','IMPORT') AND desfeito=0 GROUP BY endereco`)).map(r => [r.endereco, r.ts]));

async function enderecos(db) {
  const [rows, cont] = await Promise.all([
    db.all(`SELECT l.endereco, COUNT(*) lotes, SUM(l.qtd) qtd, SUM(l.qtd * COALESCE(p.preco,0)) valor
      FROM lotes l LEFT JOIN produtos p ON p.ean=l.ean WHERE l.qtd>0 GROUP BY l.endereco ORDER BY l.endereco`),
    ultimasContagens(db),
  ]);
  return rows.map(r => ({ ...r, gondola: U.gondola(r.endereco), ultima_contagem: cont.get(r.endereco) || null }));
}

async function esperadoNoEndereco(db, end) {
  const endereco = U.normEndereco(end);
  const [itens, ult] = await Promise.all([lotesAtivos(db, { endereco }), db.get(`SELECT MAX(ts) ts FROM eventos WHERE endereco=? AND tipo IN ('CONTAGEM','IMPORT') AND desfeito=0`, [endereco])]);
  return { endereco, endereco_ok: U.parseEndereco(endereco).valido, ultima_contagem: ult?.ts || null, itens };
}

// Perda potencial evitada, ACUMULADA desde o início, na mesma lógica da planilha original (Dashboard: soma da "Perda Potencial" das linhas "✅ Vendido").
// Para cada unidade vendida, vale a perda potencial que ela teria HOJE se ainda estivesse na prateleira: valor × desconto da faixa do prazo (50%, 20% ou 30%),
// e o valor inteiro se a validade já passou. Entram duas fontes: (1) as baixas por Venda feitas no app e (2) os lotes da planilha antiga marcados
// "✅ Vendido" que ainda estão no estoque (legado: somem daqui quando forem baixados). Venda feita depois da validade não conta. Sem preço: só unidades.
// `dias` só recorta o que aparece em `ultimos` (por padrão 30).
async function evitada(db, { dias = 30 } = {}) {
  dias = [7, 30, 90].includes(+dias) ? +dias : 30;
  const faixas = await getFaixas(db), hoje = U.hojeISO(), de = U.hojeISO(new Date(Date.now() - (dias - 1) * 864e5));
  const perdaHoje = (validade, preco, nome, categoria, q) => {
    const d = U.diasAte(validade, hoje);
    const f = classificar(d, faixas), pct = d <= 0 ? 100 : descontoPct(f, ehRacao(nome, categoria));
    if (d > 0 && !(f.peso > 0 && pct > 0)) return null;                // longe do vencimento: nada a evitar
    return { fracao: d <= 0 ? 1 : pct / 100, status: f.status, cor: f.cor, valor: preco === null || preco === undefined ? null : Number(preco) * q };
  };
  const evs = await db.all(`SELECT e.ts, e.validade, e.delta, e.historico, p.nome, p.preco, p.categoria FROM eventos e LEFT JOIN produtos p ON p.ean = e.ean
    WHERE e.tipo='BAIXA' AND e.motivo='Venda' AND e.desfeito=0`);
  const faixa = new Map();
  let total = 0, vendidoRisco = 0, unidades = 0, unidadesRisco = 0, semPreco = 0, uEv = 0, uAtual = { evitada: 0, unidades: 0 };
  const soma = (p, q, ev) => { const x = faixa.get(p.status) || { status: p.status, cor: p.cor, qtd: 0, evitada: 0 }; x.qtd += q; x.evitada += ev; faixa.set(p.status, x); };
  for (const e of evs) {
    const q = -Number(e.delta), dia = U.hojeISO(new Date(e.ts));
    unidades += q; uEv += q;
    if (!e.historico && dia > e.validade) continue;                    // vendido depois de vencer: não evitou nada
    const p = perdaHoje(e.validade, e.preco, e.nome, e.categoria, q);
    if (!p) continue;
    unidadesRisco += q;
    if (p.valor === null) { semPreco += q; continue; }
    const ev = p.valor * p.fracao;
    total += ev; vendidoRisco += p.valor; soma(p, q, ev);
    if (dia >= de) { uAtual.evitada += ev; uAtual.unidades += q; }
  }
  // legado da planilha antiga: lotes ainda no estoque marcados como vendidos
  const leg = { lotes: 0, unidades: 0, evitada: 0 };
  for (const l of await lotesAtivos(db)) {
    if (!/vendido/i.test(l.acao || '')) continue;
    leg.lotes++; leg.unidades += l.qtd;
    if (l.perda) { leg.evitada += l.perda; total += l.perda; soma({ status: l.status, cor: l.cor }, l.qtd, l.perda); }
  }
  return { dias, de, ate: hoje, evitada: +total.toFixed(2), vendido_em_risco: +vendidoRisco.toFixed(2), unidades, unidades_risco: unidadesRisco, sem_preco_un: semPreco,
    ultimos: { dias, evitada: +uAtual.evitada.toFixed(2), unidades: uAtual.unidades },
    legado: { lotes: leg.lotes, unidades: leg.unidades, evitada: +leg.evitada.toFixed(2) },
    por_faixa: [...faixa.values()].map(x => ({ ...x, evitada: +x.evitada.toFixed(2) })).sort((a, b) => b.evitada - a.evitada) };
}

// Série diária para os KPIs: fotos registradas (lib/snapshots) a partir do dia seguinte à limpeza dos lotes vendidos (antes disso os valores
// não são comparáveis) e, no fim, o ponto de hoje calculado ao vivo. Com menos de 2 pontos a tela não mostra tendência.
async function tendencia(db, todos, hoje) {
  const Snap = require('./snapshots');
  let desde = U.hojeISO(new Date(Date.now() - 29 * 864e5));
  const mig = await db.get("SELECT valor FROM config WHERE chave='migracao_vendidos'");
  if (mig) {
    try {
      const q = JSON.parse(mig.valor).quando;
      if (q) { const dia = U.hojeISO(new Date(q)); const prox = new Date(Date.parse(dia + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10); if (prox > desde) desde = prox; }
    } catch { /* config ilegível: usa a janela padrão */ }
  }
  const fotos = (await Snap.listar(db, desde)).filter(s => s.data < hoje)
    .map(s => ({ data: s.data, valor_total: Number(s.valor_total), valor_risco: Number(s.valor_risco), vencido_valor: Number(s.vencido_valor), vencido_lotes: Number(s.vencido_lotes) }));
  const h = Snap.calcular(todos);
  return { desde, pontos: [...fotos, { data: hoje, valor_total: h.valor_total, valor_risco: h.valor_risco, vencido_valor: h.vencido_valor, vencido_lotes: h.vencido_lotes }] };
}

async function resumo(db) {
  const [faixas, todos, cont] = await Promise.all([getFaixas(db), lotesAtivos(db), ultimasContagens(db)]);
  const hoje = U.hojeISO();
  await require('./snapshots').registrarSeguro(db, todos, hoje);   // foto diária para o briefing semanal
  const porStatus = faixas.map(f => ({ status: f.status, cor: f.cor, lotes: 0, qtd: 0, valor: 0, perda: 0 }));
  const idx = new Map(porStatus.map((s, i) => [s.status, i]));
  const marca = new Map(), muro = new Map(), invalidos = new Map();
  const ym0 = hoje.slice(0, 7);
  const meses = [];
  for (let i = 0; i < 12; i++) meses.push(new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1 + i, 1)).toISOString().slice(0, 7));
  const dq = { sem_preco: 0, sem_endereco: 0, endereco_fora_padrao: 0, sem_cadastro: 0, vencidos_em_estoque: 0, produtos_sem_preco: new Set(todos.filter(r => r.preco === null || r.preco === undefined).map(r => r.ean)).size };
  let valorTotal = 0, itens = 0, perdaTotal = 0, valorRisco = 0;
  for (const r of todos) {
    const s = porStatus[idx.get(r.status)];
    s.lotes++; s.qtd += r.qtd; s.valor += r.valor || 0; s.perda += r.perda || 0;
    valorTotal += r.valor || 0; itens += r.qtd; perdaTotal += r.perda || 0;
    if (r.peso > 0) valorRisco += r.valor || 0;
    const m = r.marca || '(sem marca)';
    const mm = marca.get(m) || { marca: m, lotes: 0, qtd: 0, valor: 0, perda: 0 };
    mm.lotes++; mm.qtd += r.qtd; mm.valor += r.valor || 0; mm.perda += r.perda || 0;
    marca.set(m, mm);
    const ym = r.validade.slice(0, 7);
    const chave = r.dias <= 0 ? 'Vencidos' : (ym0 <= ym && meses.includes(ym) ? ym : 'Depois');
    const mu = muro.get(chave) || { chave, lotes: 0, qtd: 0, valor: 0 };
    mu.lotes++; mu.qtd += r.qtd; mu.valor += r.valor || 0;
    muro.set(chave, mu);
    if (r.preco === null || r.preco === undefined) dq.sem_preco++;
    if (!r.endereco) dq.sem_endereco++;
    else if (!r.endereco_ok) { dq.endereco_fora_padrao++; invalidos.set(r.endereco, (invalidos.get(r.endereco) || 0) + 1); }
    if (!r.nome) dq.sem_cadastro++;
    if (r.dias <= 0) dq.vencidos_em_estoque++;
  }
  const ultGond = new Map();
  for (const [end, ts] of cont) {
    const g = U.gondola(end);
    if (g && (!ultGond.has(g) || ultGond.get(g) < ts)) ultGond.set(g, ts);
  }
  const ordemMuro = ['Vencidos', ...meses, 'Depois'];
  return {
    hoje,
    totais: { lotes: todos.length, produtos: new Set(todos.map(r => r.ean)).size, itens, valor: +valorTotal.toFixed(2), valor_em_risco: +valorRisco.toFixed(2), perda_potencial: +perdaTotal.toFixed(2) },
    por_status: porStatus.map(s => ({ ...s, valor: +s.valor.toFixed(2), perda: +s.perda.toFixed(2) })),
    muro: ordemMuro.map(k => muro.get(k) || { chave: k, lotes: 0, qtd: 0, valor: 0 }).map(m => ({ ...m, valor: +m.valor.toFixed(2) })),
    marcas: [...marca.values()].sort((a, b) => b.perda - a.perda || b.valor - a.valor).slice(0, 12).map(m => ({ ...m, valor: +m.valor.toFixed(2), perda: +m.perda.toFixed(2) })),
    evitada: await evitada(db, { dias: 30 }),
    tendencia: await tendencia(db, todos, hoje),
    qualidade: { ...dq, enderecos_fora_padrao: [...invalidos].map(([endereco, lotes]) => ({ endereco, lotes })).sort((a, b) => b.lotes - a.lotes).slice(0, 8) },
  };
}

// Mapa de calor: agrega por gôndola → célula (lado + prateleira). Células existentes: A1..A5, B1..B5, ponta F/C (com ou sem prateleira).
async function mapa(db) {
  const [todos, cont, layout, setores, dimensoes, gondolas_cfg] = await Promise.all([lotesAtivos(db), ultimasContagens(db), getLayout(db), getSetores(db), getDimensoes(db), getGondolasCfg(db)]);
  const hoje = U.hojeISO();
  const gond = new Map();
  const semLocal = { lotes: 0, qtd: 0, valor: 0, risco: 0, enderecos: new Map() };
  const novaCelula = (chave, lado, nivel) => ({ chave, lado, nivel, lotes: 0, qtd: 0, valor: 0, risco: 0, perda: 0, vencidos: 0, criticos: 0, min_dias: null, pior: null, cor: null, pior_peso: -1, ultima_contagem: null, itens: [], enderecos: new Set() });
  for (const l of todos) {
    const p = U.parseEndereco(l.endereco);
    if (p.gondola === undefined || p.gondola < 1 || p.gondola > U.GONDOLA_MAX) {
      semLocal.lotes++; semLocal.qtd += l.qtd; semLocal.valor += l.valor || 0; if (l.peso > 0) semLocal.risco += l.valor || 0;
      const k = l.endereco || '(vazio)'; semLocal.enderecos.set(k, (semLocal.enderecos.get(k) || 0) + 1);
      continue;
    }
    const g = gond.get(p.gondola) || { id: p.gondola, lotes: 0, qtd: 0, valor: 0, risco: 0, perda: 0, vencidos: 0, criticos: 0, min_dias: null, pior: null, cor: null, pior_peso: -1, dias_sem_ronda: null, celulas: new Map() };
    gond.set(p.gondola, g);
    const chave = p.tipo === 'face' ? `${p.lado}-${p.nivel}` : p.tipo === 'pallet' ? `P${p.nivel}` : p.tipo === 'ponta' ? (p.nivel ? `${p.lado}-${p.nivel}` : p.lado) : 'geral';
    const c = g.celulas.get(chave) || novaCelula(chave, p.tipo === 'gondola' ? null : p.lado, p.nivel);
    g.celulas.set(chave, c);
    for (const alvo of [c, g]) {
      alvo.lotes++; alvo.qtd += l.qtd; alvo.valor += l.valor || 0; alvo.perda += l.perda || 0;
      if (l.peso > 0) alvo.risco += l.valor || 0;
      if (l.dias <= 0) alvo.vencidos++;
      if (l.peso >= 4) alvo.criticos++;
      if (alvo.min_dias === null || l.dias < alvo.min_dias) { alvo.min_dias = l.dias; alvo.pior = l.status; alvo.cor = l.cor; alvo.pior_peso = l.peso; }
    }
    c.enderecos.add(l.endereco);
    c.itens.push({ id: l.id, nome: l.nome, ean: l.ean, lote: l.lote, qtd: l.qtd, validade: l.validade, dias: l.dias, status: l.status, cor: l.cor, desconto: l.desconto, valor: l.valor, etiquetar: l.etiquetar });
  }
  const gondolas = [...gond.values()].sort((a, b) => a.id - b.id).map(g => {
    let pior = null;
    const celulas = [...g.celulas.values()].map(c => {
      let ts = null;
      for (const e of c.enderecos) { const t = cont.get(e); if (t && (!ts || t > ts)) ts = t; }
      const dias = ts ? U.diasAte(hoje, ts.slice(0, 10)) : null;
      if (c.lotes && (dias === null ? 9999 : dias) > (pior ?? -1)) pior = dias === null ? 9999 : dias;
      c.itens.sort((a, b) => a.dias - b.dias);
      return { chave: c.chave, lado: c.lado, nivel: c.nivel, lotes: c.lotes, qtd: c.qtd, valor: +c.valor.toFixed(2), risco: +c.risco.toFixed(2), perda: +c.perda.toFixed(2), vencidos: c.vencidos, criticos: c.criticos,
        min_dias: c.min_dias, pior: c.pior, cor: c.cor, pior_peso: c.pior_peso, ultima_contagem: ts, dias_sem_ronda: dias, itens: c.itens };
    });
    return { id: g.id, lotes: g.lotes, qtd: g.qtd, valor: +g.valor.toFixed(2), risco: +g.risco.toFixed(2), perda: +g.perda.toFixed(2), vencidos: g.vencidos, criticos: g.criticos,
      min_dias: g.min_dias, pior: g.pior, cor: g.cor, pior_peso: g.pior_peso, dias_sem_ronda: pior === 9999 ? null : pior, nunca_contada: pior === 9999, celulas };
  });
  return {
    hoje, layout, setores, dimensoes, gondolas_cfg, areas: areasDe(gondolas_cfg), niveis_max: U.NIVEIS_MAX, gondolas,
    sem_local: { lotes: semLocal.lotes, qtd: semLocal.qtd, valor: +semLocal.valor.toFixed(2), risco: +semLocal.risco.toFixed(2), enderecos: [...semLocal.enderecos].map(([endereco, lotes]) => ({ endereco, lotes })) },
  };
}

// ---------- ronda do dia ----------
// Cada endereço recebe uma nota: quanto dinheiro pode se perder ali × quanto tempo faz que ninguém confere,
// mais uma parcela pequena só pela idade (para o que está longe de vencer também ser visto, devagar).
// Os N endereços com maior nota viram a ronda, depois reordenados para caminhar: gôndola, F → A → C → B.
const ORDEM_LADO = { F: 0, A: 1, C: 2, B: 3 };

// Só para ORDENAR a ronda e a fila: produto sem preço pesa pela mediana dos preços unitários da loja. Esse valor nunca aparece como dinheiro.
function precoMediano(lotes) {
  const p = lotes.filter(l => l.valor != null && l.qtd > 0).map(l => l.valor / l.qtd).sort((a, b) => a - b);
  return p.length ? p[p.length >> 1] : 0;
}

function exposicaoLote(l, pm = 0) {
  const base = (l.valor ?? pm * l.qtd) * (l.a_confirmar ? 2 : 1);      // validade a confirmar pesa em dobro: precisa ser vista logo
  const fracao = l.dias <= 0 ? 1 : l.desconto > 0 ? l.desconto / 100 : l.dias <= 120 ? 0.05 : 0.01;
  return base * fracao * (l.etiquetado ? 0.4 : 1);
}

async function ronda(db, { n = 20, setores: so = null } = {}) {
  n = Math.max(5, Math.min(60, Math.round(+n) || 20));
  const meus = so && so.length ? new Set(so) : null;   // "só os meus setores": lista de "gôndola-lado"
  const [todos, cont, setores, gcfg] = await Promise.all([lotesAtivos(db), ultimasContagens(db), getSetores(db), getGondolasCfg(db)]);
  const hoje = U.hojeISO();
  const por = new Map();
  const pm = precoMediano(todos), semEnd = { lotes: 0, qtd: 0 };
  let exposicaoTotal = 0, feitosHoje = 0;
  for (const l of todos) {
    if (!l.endereco) { if (!meus) { semEnd.lotes++; semEnd.qtd += l.qtd; } continue; }
    if (meus) { const p = U.parseEndereco(l.endereco); if (!(p.lado ? meus.has(`${p.gondola}-${p.lado}`) : [...meus].some(k => k.startsWith(`${p.gondola}-`)))) continue; }
    let e = por.get(l.endereco);
    if (!e) {
      const ts = cont.get(l.endereco) || null;
      const p = U.parseEndereco(l.endereco);
      const g = p.gondola ?? +(l.endereco.match(/^(\d{1,2})/)?.[1] ?? 99);
      e = { endereco: l.endereco, gondola: g, lado: p.lado || null, nivel: p.nivel ?? null, valido: p.valido, ultima_contagem: ts,
        dias_sem: ts ? Math.max(0, U.diasAte(hoje, U.hojeISO(new Date(ts)))) : null,
        lotes: 0, qtd: 0, vencidos: 0, urgentes: 0, etiquetar: {}, exposicao: 0 };
      por.set(l.endereco, e);
    }
    e.lotes++; e.qtd += l.qtd;
    if (l.dias <= 0) e.vencidos++; else if (l.dias <= 30) e.urgentes++;
    if (l.etiquetar) e.etiquetar[l.desconto] = (e.etiquetar[l.desconto] || 0) + 1;
    e.exposicao += exposicaoLote(l, pm);
  }
  const candidatos = [];
  for (const e of por.values()) {
    exposicaoTotal += e.exposicao;
    if (e.dias_sem === 0) { feitosHoje++; continue; }        // já conferido hoje
    const mult = e.dias_sem === null ? 4 : 1 + Math.min(e.dias_sem, 90) / 30;
    const idade = (e.dias_sem === null ? 1 : Math.min(e.dias_sem, 120) / 120) * 10;
    candidatos.push({ ...e, exposicao: +e.exposicao.toFixed(2), score: +((e.exposicao * mult + idade) * (e.valido ? 1 : 2)).toFixed(2) });   // endereço fora do padrão não aparece direito no mapa: sobe na ronda
  }
  candidatos.sort((a, b) => b.score - a.score);
  const escolhidos = candidatos.slice(0, n);
  const coberto = escolhidos.reduce((s, e) => s + e.exposicao, 0);
  escolhidos.sort((a, b) => a.gondola - b.gondola || (ORDEM_LADO[a.lado] ?? 9) - (ORDEM_LADO[b.lado] ?? 9) || (a.nivel ?? 0) - (b.nivel ?? 0) || a.endereco.localeCompare(b.endereco));
  return {
    hoje, n, setores, sem_endereco: semEnd, nomes_gondolas: Object.fromEntries(Object.entries(gcfg).filter(([, v]) => v.nome).map(([k, v]) => [k, v.nome])), candidatos: candidatos.length, conferidos_hoje: feitosHoje,
    cobertura: exposicaoTotal ? +(coberto / exposicaoTotal * 100).toFixed(1) : 0,
    exposicao_total: +exposicaoTotal.toFixed(2),
    enderecos: escolhidos.map(({ ultima_contagem, ...e }) => e),
  };
}

// Briefing de uma página: o que retirar, o que etiquetar e a ronda do dia, na ordem de caminhada.
const VAGAS_BRIEFING = 12;
async function briefing(db) {
  const [todos, r, setores, res] = await Promise.all([lotesAtivos(db), ronda(db, { n: 10 }), getSetores(db), resumo(db)]);
  const respDe = end => { const p = U.parseEndereco(end); const x = p.lado && setores[p.gondola] && setores[p.gondola][p.lado]; return x ? x.resp : []; };
  const chave = end => { const p = U.parseEndereco(end); return [p.gondola ?? 99, ORDEM_LADO[p.lado] ?? 9, p.nivel ?? 0]; };
  const caminhada = (a, b) => { const x = chave(a.endereco), y = chave(b.endereco); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.endereco.localeCompare(b.endereco); };
  const linha = l => ({ endereco: l.endereco || '', nome: l.nome || l.ean, ean: l.ean, lote: l.lote, qtd: l.qtd, dias: l.dias, validade: l.validade, valor: l.valor, desconto: l.desconto, resp: respDe(l.endereco) });
  const vencidos = todos.filter(l => l.dias <= 0).sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0));
  const etiquetar = todos.filter(l => l.etiquetar).sort((a, b) => a.dias - b.dias);
  const soma = ls => +ls.reduce((s, l) => s + (l.valor || 0), 0).toFixed(2);
  return {
    hoje: r.hoje,
    totais: { valor_em_risco: res.totais.valor_em_risco, vencido_valor: soma(vencidos), vencido_lotes: vencidos.length, etiquetar_lotes: etiquetar.length },
    retirar: { total: vencidos.length, mostrados: Math.min(VAGAS_BRIEFING, vencidos.length), itens: vencidos.slice(0, VAGAS_BRIEFING).map(linha).sort(caminhada) },
    etiquetar: { total: etiquetar.length, mostrados: Math.min(VAGAS_BRIEFING, etiquetar.length), itens: etiquetar.slice(0, VAGAS_BRIEFING).map(linha).sort(caminhada) },
    ronda: { conferidos_hoje: r.conferidos_hoje, cobertura: r.cobertura, enderecos: r.enderecos.map(e => ({ endereco: e.endereco, lotes: e.lotes, vencidos: e.vencidos, urgentes: e.urgentes, nunca: e.dias_sem === null, dias_sem: e.dias_sem, resp: respDe(e.endereco) })) },
    marcas: res.marcas.slice(0, 3).map(m => ({ marca: m.marca, perda: m.perda })),
  };
}

// Resultado das rondas dos últimos dias, tirado dos próprios lançamentos (motivo "Ronda: …").
async function rondaPainel(db, dias = 7) {
  dias = Math.max(1, Math.min(31, +dias || 7));
  const desde = new Date(Date.now() - (dias + 1) * 864e5).toISOString();
  const evs = await db.all(`SELECT ts, tipo, endereco, operador, motivo FROM eventos
    WHERE ts >= ? AND desfeito=0 AND historico=0 AND (motivo LIKE 'Ronda:%' OR tipo='ETIQUETA') ORDER BY ts`, [desde]);
  const mapa = new Map();
  for (const e of evs) {
    const dia = U.hojeISO(new Date(e.ts));
    const d = mapa.get(dia) || { dia, enderecos: new Set(), operadores: new Set(), confere: 0, corrigido: 0, nao_achei: 0, sem_bipar: 0, etiquetas: 0 };
    mapa.set(dia, d);
    if (e.tipo === 'ETIQUETA') { d.etiquetas++; continue; }
    d.enderecos.add(e.endereco); d.operadores.add(e.operador);
    if (e.motivo.startsWith('Ronda: corrigido')) d.corrigido++;
    else if (e.motivo.startsWith('Ronda: não encontrado')) d.nao_achei++;
    else { d.confere++; if (e.motivo.includes('sem bipar')) d.sem_bipar++; }
  }
  return [...mapa.values()].sort((a, b) => b.dia.localeCompare(a.dia)).map(d => {
    const lotes = d.confere + d.corrigido + d.nao_achei;
    return { dia: d.dia, enderecos: d.enderecos.size, operadores: [...d.operadores], lotes, confere: d.confere, corrigido: d.corrigido, nao_achei: d.nao_achei,
      sem_bipar: d.sem_bipar, etiquetas: d.etiquetas, divergencia: lotes ? +((d.corrigido + d.nao_achei) / lotes * 100).toFixed(1) : null };
  });
}

async function fila(db, limite = 40) {
  const todos = await lotesAtivos(db), pm = precoMediano(todos);
  return todos.filter(r => r.peso > 0)
    .map(r => ({ ...r, score: (r.valor ?? pm * r.qtd) * r.peso }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limite)
    .map(r => ({ ...r, acao_sugerida: r.status === 'Vencido' ? 'Retirar da loja e enviar para RMA (CD)' : r.desconto > 0 ? `Etiquetar ${r.desconto}% e levar para a frente` : 'Posicionar na frente (FEFO)' }));
}

async function etiquetas(db) {
  const rows = (await lotesAtivos(db)).filter(r => r.desconto > 0 && r.status !== 'Vencido');
  const grupos = {};
  for (const r of rows) (grupos[r.desconto] = grupos[r.desconto] || []).push(r);
  return Object.keys(grupos).sort((a, b) => b - a).map(k => ({ desconto: +k, itens: grupos[k] }));
}

async function eventos(db, { limite = 100, ean, tipo } = {}) {
  const where = [], args = [];
  if (ean) { where.push('e.ean = ?'); args.push(U.normEan(ean)); }
  if (tipo) { where.push('e.tipo = ?'); args.push(tipo); }
  return db.all(`SELECT e.*, p.nome FROM eventos e LEFT JOIN produtos p ON p.ean=e.ean
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts DESC, e.id DESC LIMIT ?`, [...args, Math.min(+limite || 100, 2000)]);
}

module.exports = {
  getFaixas, setFaixas, getSetores, setSetores, getGondolasCfg, setGondolasCfg, sincronizaAreas, areasDe, getDimensoes, setDimensoes, getValidadeMinima, setValidadeMinima, placar, getLayout, setLayout, layoutPadrao, enrich, lotesAtivos, ordenaLotes, agrupaPorProduto, ordenaGrupos, precoAntigo, historicoPrecos, PRECO_ANTIGO_DIAS, tendencia, getProduto, upsertProduto, infoProduto, leitura, desfazer,
  enderecos, esperadoNoEndereco, resumo, mapa, fila, ronda, briefing, rondaPainel, etiquetas, eventos, MOTIVOS_BAIXA, evitada, exposicaoLote, precoMediano, misturar, confirmarValidade, ajusteTotal,
};
