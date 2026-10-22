// Roteador único: usado pelo servidor local (server.js) e pela função da Vercel (api/[...path].js).
const fs = require('node:fs');
const path = require('node:path');
const { obter } = require('./db');
const S = require('./service');
const X = require('./excel');
const CAUSAS = require('./causas');
const A = require('./auth');
const AUD = require('./auditoria');
const { HttpError, hojeISO } = require('./util');
const FOLHA = require('./folha-rotas');
const CONF = require('./conferencias');

const PUBLIC = path.join(__dirname, '..', 'public');
// Mesmos cabeçalhos do vercel.json, para o ambiente local se comportar igual (câmera liberada só para o próprio site).
const SEGURANCA = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()"
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

async function lerCorpo(req, limite) {
  const pronto = req.body; // na Vercel o corpo já vem lido
  if (pronto !== undefined && pronto !== null) {
    const buf = Buffer.isBuffer(pronto) ? pronto : Buffer.from(typeof pronto === 'string' ? pronto : JSON.stringify(pronto));
    if (buf.length > limite) throw new HttpError(413, 'corpo grande demais');
    return buf;
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let tam = 0;
    req.on('data', c => {
      tam += c.length;
      if (tam > limite) { reject(new HttpError(413, 'corpo grande demais')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

const https = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';

// [método, regex, {admin?}, função(ctx)]   ctx = { db, m (grupos da URL), q (query), body, user, operador }
const ROTAS = [
  ...AUD.ROTAS,
  ...CONF.ROTAS,
  ['GET', /^\/api\/resumo$/, {}, c => S.resumo(c.db)],
  ['GET', /^\/api\/mapa$/, {}, c => S.mapa(c.db)],
  ['GET', /^\/api\/fila$/, {}, c => S.fila(c.db, +c.q.get('limite') || 40)],
  ['GET', /^\/api\/ronda$/, {}, c => S.ronda(c.db, { n: c.q.get('n'), setores: (c.q.get('setores') || '').split(',').filter(x => /^\d+-[A-Z]+$/.test(x)) })],
  ['GET', /^\/api\/briefing$/, {}, c => S.briefing(c.db)],
  ['GET', /^\/api\/briefing-semanal$/, {}, c => require('./semanal').briefingSemanal(c.db)],
  ['GET', /^\/api\/ronda\/painel$/, {}, c => S.rondaPainel(c.db, c.q.get('dias'))],
  ['GET', /^\/api\/lotes$/, {}, async c => {
    let rows = await S.lotesAtivos(c.db, { q: c.q.get('q'), endereco: c.q.get('endereco'), gondola: c.q.get('gondola'), marca: c.q.get('marca') });
    const st = c.q.get('status');
    if (st) rows = rows.filter(r => r.status === st);
    if (c.q.get('sempreco') === '1') rows = rows.filter(r => r.preco === null || r.preco === undefined);
    const off = +c.q.get('offset') || 0, lim = Math.min(+c.q.get('limite') || 100, 1000);
    return { total: rows.length, itens: rows.slice(off, off + lim), marcas: [...new Set(rows.map(r => r.marca).filter(Boolean))].sort() };
  }],
  ['GET', /^\/api\/produto\/(\d+)$/, {}, c => S.infoProduto(c.db, c.m[0])],
  ['POST', /^\/api\/produtos$/, {}, c => S.upsertProduto(c.db, c.body)],
  ['POST', /^\/api\/leituras$/, {}, c => S.leitura(c.db, { ...c.body, operador: c.operador })],
  ['POST', /^\/api\/desfazer$/, {}, c => S.desfazer(c.db, c.body.grupo)],
  ['GET', /^\/api\/enderecos$/, {}, c => S.enderecos(c.db)],
  ['GET', /^\/api\/enderecos\/([^/]+)$/, {}, c => S.esperadoNoEndereco(c.db, decodeURIComponent(c.m[0]))],
  ['GET', /^\/api\/eventos$/, {}, c => S.eventos(c.db, { limite: c.q.get('limite'), ean: c.q.get('ean'), tipo: c.q.get('tipo') })],
  ['GET', /^\/api\/etiquetas$/, {}, c => S.etiquetas(c.db)],
  ['GET', /^\/api\/causas$/, {}, async c => ({ ...(await CAUSAS.pareto(c.db, c.q.get('dias') || 30)), causas: CAUSAS.CAUSAS, motivos_com_causa: CAUSAS.MOTIVOS_COM_CAUSA })],
  ['GET', /^\/api\/config$/, {}, async c => ({ faixas: await S.getFaixas(c.db), motivos_baixa: S.MOTIVOS_BAIXA, validade_minima: await S.getValidadeMinima(c.db), areas: S.areasDe(await S.getGondolasCfg(c.db)) })],
  ['PUT', /^\/api\/config$/, { admin: true }, async c => {
    if (c.body.faixas !== undefined) await S.setFaixas(c.db, c.body.faixas);
    if (c.body.validade_minima !== undefined) await S.setValidadeMinima(c.db, c.body.validade_minima);
    return { faixas: await S.getFaixas(c.db), validade_minima: await S.getValidadeMinima(c.db) };
  }],
  ['GET', /^\/api\/placar$/, { admin: true }, c => S.placar(c.db)],
  ['GET', /^\/api\/setores$/, {}, c => S.getSetores(c.db)],
  ['PUT', /^\/api\/setores$/, { admin: true }, c => S.setSetores(c.db, c.body)],
  ['GET', /^\/api\/gondolas$/, {}, c => S.getGondolasCfg(c.db)],
  ['PUT', /^\/api\/gondolas$/, { admin: true }, c => S.setGondolasCfg(c.db, c.body)],
  ['GET', /^\/api\/dimensoes$/, {}, c => S.getDimensoes(c.db)],
  ['PUT', /^\/api\/dimensoes$/, { admin: true }, c => S.setDimensoes(c.db, c.body)],
  ['GET', /^\/api\/layout$/, {}, c => S.getLayout(c.db)],
  ['PUT', /^\/api\/layout$/, { admin: true }, c => S.setLayout(c.db, c.body)],
  ['DELETE', /^\/api\/layout$/, { admin: true }, async c => { await c.db.run("DELETE FROM config WHERE chave='layout'"); return S.getLayout(c.db); }],
  ['GET', /^\/api\/usuarios$/, { admin: true }, c => A.listarUsuarios(c.db)],
  ['POST', /^\/api\/usuarios$/, { admin: true }, async c => { await A.salvarUsuario(c.db, c.body); return A.listarUsuarios(c.db); }],
  ['PUT', /^\/api\/usuarios\/([^/]+)$/, { admin: true }, async c => { await A.salvarUsuario(c.db, { ...c.body, nome: decodeURIComponent(c.m[0]) }); return A.listarUsuarios(c.db); }],
  ...FOLHA.ROTAS,
];

async function api(req, res, url) {
  const db = await obter();
  await S.sincronizaAreas(db);
  const metodo = req.method;
  const exigeLogin = A.loginObrigatorio();

  if (metodo === 'GET' && url.pathname === '/api/ping') return json(res, 200, { ok: true, hoje: hojeISO(), login: exigeLogin });

  if (metodo !== 'GET' && req.headers['x-requested-with'] !== 'validade') throw new HttpError(403, 'requisição não permitida');

  if (url.pathname === '/api/login' && metodo === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req, 4096)).toString('utf8') || '{}');
    const u = await A.login(db, corpo.nome, corpo.pin);
    return json(res, 200, u, { 'Set-Cookie': A.cookieSessao(u.nome, https(req)) });
  }
  if (url.pathname === '/api/logout' && metodo === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': A.cookieLogout(https(req)) });

  const user = await A.usuarioDaRequisicao(db, req);
  if (url.pathname === '/api/eu' && metodo === 'GET') {
    if (exigeLogin && !user) throw new HttpError(401, 'Faça login');
    return json(res, 200, { login: exigeLogin, usuario: user, operadores: exigeLogin ? [] : await A.nomesAtivos(db) });
  }
  if (exigeLogin && !user) throw new HttpError(401, 'Faça login');
  const admin = !exigeLogin || user.papel === 'admin';

  if (metodo === 'GET' && url.pathname === '/api/export.xlsx') {
    const buf = Buffer.from(await X.exportar(db));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Controle_Validade_${hojeISO()}.xlsx"`,
      'Content-Length': buf.length, 'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }
  if (metodo === 'POST' && url.pathname === '/api/import') {
    if (!admin) throw new HttpError(403, 'apenas administradores');
    const buf = await lerCorpo(req, 4 * 1024 * 1024);
    return json(res, 200, await X.importar(db, buf, { substituir: url.searchParams.get('substituir') === '1' }));
  }

  for (const [m, re, opts, fn] of ROTAS) {
    if (m !== metodo) continue;
    const mt = url.pathname.match(re);
    if (!mt) continue;
    if (opts.admin && !admin) throw new HttpError(403, 'apenas administradores');
    let body = {};
    if (metodo === 'POST' || metodo === 'PUT') {
      const raw = await lerCorpo(req, FOLHA.LIMITE_CORPO[url.pathname] || 2 * 1024 * 1024);
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
    }
    const operador = user ? user.nome : String(body.operador || 'LOCAL').trim().toUpperCase();
    const saida = await fn({ db, m: mt.slice(1), q: url.searchParams, body, user, operador });
    if (saida && saida.__raw) { res.writeHead(saida.__raw.status, saida.__raw.headers); return res.end(saida.__raw.body); }   // resposta que não é JSON (CSV)
    return json(res, 200, saida);
  }
  throw new HttpError(404, 'rota não encontrada');
}

function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/coletor') p = '/coletor.html';
  if (p === '/login') p = '/login.html';
  if (p === '/briefing') p = '/briefing.html';
  if (p === '/conferencia') p = '/conferencia.html';
  if (p === '/briefing-semanal') p = '/briefing-semanal.html';
  const arq = path.normalize(path.join(PUBLIC, p));
  if (!arq.startsWith(PUBLIC + path.sep) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('não encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEGURANCA });
  fs.createReadStream(arq).pipe(res);
}

async function handler(req, res, { estaticos = false } = {}) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api')) await api(req, res, url);
    else if (estaticos) estatico(req, res, url);
    else { res.writeHead(404); res.end(); }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { erro: status === 500 ? 'erro interno' : e.message, ...(status === 401 ? { login: true } : {}) });
    else res.end();
  }
}

module.exports = { handler };
