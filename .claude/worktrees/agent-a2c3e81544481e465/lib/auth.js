const crypto = require('node:crypto');
const { HttpError, agoraISO } = require('./util');

const DIAS_SESSAO = 14;
const MAX_FALHAS = 5;
const BLOQUEIO_MIN = 10;
const PIN_RE = /^\d{6,8}$/;

let segredoLocal = null;
function segredo() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 24) return process.env.SESSION_SECRET;
  if (process.env.VERCEL) throw new HttpError(500, 'SESSION_SECRET não configurado no servidor (mínimo 24 caracteres)');
  segredoLocal = segredoLocal || crypto.randomBytes(32).toString('hex'); // só desenvolvimento: sessões caem ao reiniciar
  return segredoLocal;
}

// Login obrigatório na Vercel, na rede (--lan) ou com REQUIRE_LOGIN=1. Só fica livre no localhost.
function loginObrigatorio() {
  return !!process.env.VERCEL || process.env.REQUIRE_LOGIN === '1' || process.argv.includes('--lan');
}

const normNome = n => String(n ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
// compara nomes sem acento e sem espaços repetidos ("Dânyllo" entra como DANYLLO)
const semAcento = n => normNome(n).normalize('NFD').replace(new RegExp(String.fromCharCode(92) + 'p{Diacritic}', 'gu'), '');

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function iguais(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function salvarUsuario(db, { nome, pin, papel, ativo }) {
  nome = normNome(nome);
  if (!nome || nome.length > 40) throw new HttpError(400, 'nome inválido');
  if (papel !== undefined && !['admin', 'operador'].includes(papel)) throw new HttpError(400, 'papel deve ser admin ou operador');
  if (pin !== undefined && pin !== null && pin !== '' && !PIN_RE.test(String(pin))) throw new HttpError(400, 'o PIN deve ter de 6 a 8 números');
  const atual = await db.get('SELECT * FROM usuarios WHERE nome = ?', [nome]);
  if (!atual) {
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run('INSERT INTO usuarios(nome, papel, pin_hash, salt, ativo, criado_em) VALUES(?,?,?,?,?,?)',
      [nome, papel || 'operador', pin ? hashPin(String(pin), salt) : null, pin ? salt : null, ativo === false ? 0 : 1, agoraISO()]);
    return nome;
  }
  if (atual.papel === 'admin' && (papel === 'operador' || ativo === false)) {
    const outros = await db.get("SELECT COUNT(*) n FROM usuarios WHERE papel='admin' AND ativo=1 AND nome<>?", [nome]);
    if (!outros.n) throw new HttpError(409, 'precisa existir pelo menos um administrador ativo');
  }
  if (pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    await db.run('UPDATE usuarios SET pin_hash=?, salt=?, falhas=0, bloqueado_ate=NULL WHERE nome=?', [hashPin(String(pin), salt), salt, nome]);
  }
  if (papel) await db.run('UPDATE usuarios SET papel=? WHERE nome=?', [papel, nome]);
  if (ativo !== undefined) await db.run('UPDATE usuarios SET ativo=? WHERE nome=?', [ativo ? 1 : 0, nome]);
  return nome;
}

async function listarUsuarios(db) {
  return db.all('SELECT nome, papel, ativo, (pin_hash IS NOT NULL) AS tem_pin, falhas, bloqueado_ate FROM usuarios ORDER BY nome');
}

async function nomesAtivos(db) {
  return (await db.all('SELECT nome FROM usuarios WHERE ativo=1 ORDER BY nome')).map(r => r.nome);
}

async function login(db, nome, pin) {
  const digitado = semAcento(nome);
  const u = (await db.all('SELECT * FROM usuarios WHERE ativo = 1')).find(x => semAcento(x.nome) === digitado);
  const pinTxt = String(pin ?? '').replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), '');       // ignora espaços e traços colados ou digitados
  if (!u) throw new HttpError(401, 'Usuário não encontrado. Digite o seu nome como aparece em Configurações → Equipe.');
  if (!u.pin_hash) throw new HttpError(401, 'Este usuário ainda não tem PIN. Peça a um administrador para criar um em Configurações → Equipe.');
  if (u.bloqueado_ate && u.bloqueado_ate > agoraISO()) {
    const min = Math.max(1, Math.ceil((Date.parse(u.bloqueado_ate) - Date.now()) / 60000));
    throw new HttpError(429, 'Muitas tentativas erradas. Tente de novo em ' + min + ' min, ou peça a um administrador para criar um PIN novo.');
  }
  if (!iguais(hashPin(pinTxt, u.salt), u.pin_hash)) {
    const falhas = u.falhas + 1;
    if (falhas >= MAX_FALHAS) {
      await db.run('UPDATE usuarios SET falhas=0, bloqueado_ate=? WHERE nome=?', [new Date(Date.now() + BLOQUEIO_MIN * 60000).toISOString(), u.nome]);
      throw new HttpError(429, 'PIN incorreto. Acesso bloqueado por ' + BLOQUEIO_MIN + ' min; um administrador pode criar um PIN novo agora.');
    }
    await db.run('UPDATE usuarios SET falhas=? WHERE nome=?', [falhas, u.nome]);
    throw new HttpError(401, 'PIN incorreto. Restam ' + (MAX_FALHAS - falhas) + ' tentativa(s).');
  }
  await db.run('UPDATE usuarios SET falhas=0, bloqueado_ate=NULL WHERE nome=?', [u.nome]);
  return { nome: u.nome, papel: u.papel };
}

// Token assinado: base64url(json) + "." + HMAC. Papel e validade conferidos de novo no banco a cada pedido.
function assinar(dados) {
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const mac = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  return `${corpo}.${mac}`;
}

function verificar(token) {
  if (!token || !token.includes('.')) return null;
  const [corpo, mac] = token.split('.');
  const esperado = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

function cookieSessao(nome, seguro) {
  const token = assinar({ u: nome, exp: Date.now() + DIAS_SESSAO * 864e5 });
  return `vs=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DIAS_SESSAO * 86400}${seguro ? '; Secure' : ''}`;
}

const cookieLogout = seguro => `vs=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${seguro ? '; Secure' : ''}`;

function lerCookie(req, nome) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return null;
}

async function usuarioDaRequisicao(db, req) {
  const d = verificar(lerCookie(req, 'vs'));
  if (!d) return null;
  const u = await db.get('SELECT nome, papel FROM usuarios WHERE nome=? AND ativo=1', [d.u]);
  return u || null;
}

module.exports = { loginObrigatorio, salvarUsuario, listarUsuarios, nomesAtivos, login, cookieSessao, cookieLogout, usuarioDaRequisicao, normNome };
