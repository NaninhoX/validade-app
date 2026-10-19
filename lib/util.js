const pad = n => String(n).padStart(2, '0');

// A loja é em São Paulo; o servidor (Vercel) roda em UTC. Sem isso, depois das 21h "hoje" viraria amanhã.
const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function hojeISO(d = new Date()) {
  return fmtDia.format(d);
}

// Date cujos campos UTC são o relógio de parede da loja (Excel não tem fuso).
function relogioLoja(ts) {
  const p = Object.fromEntries(fmtHora.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}

function diasAte(iso, hoje = hojeISO()) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(hoje + 'T00:00:00Z')) / 864e5);
}

function agoraISO() {
  return new Date().toISOString();
}

// EAN só com dígitos; UPC-A (12) vira EAN-13. Mantém zeros à esquerda como texto.
function normEan(v) {
  if (v === null || v === undefined) return null;
  let s = typeof v === 'number' ? v.toFixed(0) : String(v);
  s = s.replace(/\D/g, '');
  if (!s) return null;
  if (s.length === 12) s = '0' + s;
  return s;
}

function eanKey(ean) {
  return ean ? String(ean).replace(/^0+/, '') : null;
}

function normEndereco(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toUpperCase().replace(/\s+/g, '').replace(/[–—_.\/]/g, '-');
}

// Endereço = GÔNDOLA-LADO-PRATELEIRA, ex.: 1-B-3
//   lado A = esquerda, B = direita; F/C = ponta da gôndola (Frente / Costas), com ou sem prateleira (1-F, 1-F-2).
const NIVEIS_MAX = 5;
const GONDOLA_MAX = 40;

function parseEndereco(e) {
  e = normEndereco(e);
  if (!e) return { valido: false, tipo: 'vazio' };
  let m;
  if ((m = e.match(/^(\d{1,2})$/))) return { valido: false, tipo: 'gondola', gondola: +m[1] };           // legado: só a gôndola
  if ((m = e.match(/^(\d{1,2})-([FC])$/))) return ok({ gondola: +m[1], lado: m[2], nivel: null, tipo: 'ponta' });
  if ((m = e.match(/^(\d{1,2})-([FC])-(\d)$/))) return ok({ gondola: +m[1], lado: m[2], nivel: +m[3], tipo: 'ponta' });
  if ((m = e.match(/^(\d{1,2})-([AB])-(\d)$/))) return ok({ gondola: +m[1], lado: m[2], nivel: +m[3], tipo: 'face' });
  return { valido: false, tipo: 'invalido' };
  function ok(o) {
    o.valido = o.gondola >= 1 && o.gondola <= GONDOLA_MAX && (o.nivel === null || (o.nivel >= 1 && o.nivel <= NIVEIS_MAX));
    return o;
  }
}

function gondola(endereco) {
  const p = parseEndereco(endereco);
  return p.gondola !== undefined ? String(p.gondola) : '';
}

function erroEndereco(e) {
  const p = parseEndereco(e);
  if (p.valido) return null;
  return `endereço "${e}" fora do padrão — use GÔNDOLA-LADO-PRATELEIRA, ex.: 1-B-3 (lado A ou B, prateleira 1 a ${NIVEIS_MAX}; ponta: 1-F ou 1-C)`;
}

function normLote(v) {
  const s = v === null || v === undefined ? '' : String(v).trim().toUpperCase();
  return s || 'S/L';
}

function ultimoDiaMes(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function iso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Aceita Date, serial do Excel, ISO, dd/mm/aaaa, dd/mm/aa, mm/aa, mm/aaaa, DDMMAA, DDMMAAAA, MMAA.
// Mês/ano vira o último dia do mês.
function parseData(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valida(+m[1], +m[2], +m[3]);
  const partes = s.split(/[\/\-.\s]+/).filter(Boolean);
  const ano = a => (a < 100 ? 2000 + a : a);
  if (partes.length === 3 && partes.every(p => /^\d+$/.test(p))) return valida(ano(+partes[2]), +partes[1], +partes[0]);
  if (partes.length === 2 && partes.every(p => /^\d+$/.test(p))) {
    const y = ano(+partes[1]), mo = +partes[0];
    return valida(y, mo, mo >= 1 && mo <= 12 ? ultimoDiaMes(y, mo) : 1);
  }
  const dig = s.replace(/\D/g, '');
  if (dig.length === 6) return valida(ano(+dig.slice(4)), +dig.slice(2, 4), +dig.slice(0, 2));
  if (dig.length === 8) return valida(+dig.slice(4), +dig.slice(2, 4), +dig.slice(0, 2));
  if (dig.length === 4) {
    const y = ano(+dig.slice(2)), mo = +dig.slice(0, 2);
    return valida(y, mo, mo >= 1 && mo <= 12 ? ultimoDiaMes(y, mo) : 1);
  }
  return null;
}

function valida(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > ultimoDiaMes(y, m)) return null;
  return iso(y, m, d);
}

function brData(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-');
  return `${d}/${m}/${y}`;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

module.exports = {
  TZ, NIVEIS_MAX, GONDOLA_MAX, hojeISO, relogioLoja, diasAte, agoraISO, normEan, eanKey, gondola, normEndereco, parseEndereco, erroEndereco,
  normLote, parseData, brData, HttpError,
};
