'use strict';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => (n === null || n === undefined ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const brlK = n => (n === null || n === undefined ? '—' : Math.abs(n) >= 10000 ? 'R$ ' + (n / 1000).toFixed(0) + 'k' : Math.abs(n) >= 1000 ? 'R$ ' + (n / 1000).toFixed(1).replace('.', ',') + 'k' : 'R$ ' + Math.round(n));
const int = n => (n ?? 0).toLocaleString('pt-BR');
const brData = iso => (iso ? iso.split('-').reverse().join('/') : '');
const brDataHora = ts => (ts ? new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } }

async function api(path, opts = {}) {
  const bin = opts.body instanceof ArrayBuffer;
  const headers = { 'X-Requested-With': 'validade' };
  if (opts.body !== undefined) headers['Content-Type'] = bin ? 'application/octet-stream' : 'application/json';
  // Consulta (GET) tenta de novo se a rede do celular falhar por um instante; gravação não repete sozinha (a fila do coletor cuida disso).
  const tentativas = opts.tentativas ?? ((opts.method || 'GET') === 'GET' ? 2 : 0);
  let r;
  for (let i = 0; ; i++) {
    try {
      r = await fetch(path, {
        method: opts.method || 'GET', headers, credentials: 'same-origin',
        body: opts.body === undefined ? undefined : (bin ? opts.body : JSON.stringify(opts.body)),
      });
      break;
    } catch {
      if (i >= tentativas) { const er = new Error('Não consegui falar com o servidor. Confira o Wi-Fi ou o sinal e tente de novo.'); er.rede = true; throw er; }
      await new Promise(ok => setTimeout(ok, 600 * (i + 1)));
    }
  }
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  if (r.status === 401 && !opts.semRedirect && !location.pathname.startsWith('/login')) {
    location.href = '/login?volta=' + encodeURIComponent(location.pathname + location.hash);
    return new Promise(() => {});
  }
  if (!r.ok) { const e = new Error((data && data.erro) || `erro ${r.status}`); e.status = r.status; throw e; }
  return data;
}

// ---------- ícones (traços 24×24) ----------
const ICONS = {
  grid: 'M4 4h7v9H4z M13 4h7v5h-7z M13 11h7v9h-7z M4 15h7v5H4z',
  map: 'M9 4 3 6.5v14L9 18l6 3 6-2.5v-14L15 7z M9 4v14 M15 7v14',
  box: 'M21 8 12 3 3 8v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  tag: 'M3 12V4h8l10 10-8 8z M7.5 7.5h.01',
  clock: 'M12 7v5l3 2 M21 12a9 9 0 1 1-3-6.7 M21 4v5h-5',
  sliders: 'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3 M16 4h3a1 1 0 0 1 1 1v3 M20 16v3a1 1 0 0 1-1 1h-3 M8 20H5a1 1 0 0 1-1-1v-3 M7 12h10',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  upload: 'M12 16V5 M7 9l5-5 5 5 M5 20h14',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6 6 18',
  check: 'M5 12l5 5 9-10',
  undo: 'M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',
  alert: 'M12 3 2 20h20z M12 10v4 M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  logout: 'M9 4H5v16h4 M16 8l4 4-4 4 M20 12H9',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M2 20a7 7 0 0 1 14 0 M17 4.5a3.5 3.5 0 0 1 0 6.5 M22 20a7 7 0 0 0-4-6.3',
  chevron: 'M9 6l6 6-6 6',
  refresh: 'M20 11a8 8 0 1 0-2 6 M20 4v7h-7',
  move: 'M5 9l-3 3 3 3 M9 5l3-3 3 3 M15 19l-3 3-3-3 M19 9l3 3-3 3 M2 12h20 M12 2v20',
  minus: 'M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  printer: 'M7 8V4h10v4 M6 17H4v-7h16v7h-2 M7 14h10v6H7z',
  flame: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-9z',
  layers: 'M12 3 3 8l9 5 9-5z M3 13l9 5 9-5',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9h.01',
  flash: 'M13 2 4 14h7l-1 8 9-12h-7z',
  rotate: 'M4 12a8 8 0 0 1 14-5 M20 4v5h-5 M20 12a8 8 0 0 1-14 5 M4 20v-5h5',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
};
const ico = (nome, tam) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${tam ? ` style="width:${tam}px;height:${tam}px"` : ''}>${ICONS[nome].split(' M').map((d, i) => `<path d="${i ? 'M' : ''}${d}"/>`).join('')}</svg>`;

// ---------- feedback ----------
let toastTimer;
function toast(msg, tipo = '', ms = 3500) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = 'toast ' + tipo;
  t.innerHTML = ico(tipo === 'bad' ? 'alert' : tipo === 'ok' ? 'check' : 'info') + `<span>${esc(msg)}</span>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }

// número que "sobe" até o valor (respeita prefers-reduced-motion)
function contar(el, alvo, fmt = int, ms = 900) {
  if (alvo === null || alvo === undefined) { el.textContent = '—'; return; }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(alvo); return; }
  const t0 = performance.now();
  const passo = t => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 4);
    el.textContent = fmt(alvo * e);
    if (p < 1) requestAnimationFrame(passo); else el.textContent = fmt(alvo);
  };
  requestAnimationFrame(passo);
}

// Mesma regra do servidor: mês/ano => último dia do mês.
function parseData(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const ult = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ano = a => (a < 100 ? 2000 + a : a);
  const ok = (y, m, d) => (y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= ult(y, m) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  const p = s.split(/[\/\-.\s]+/).filter(Boolean);
  if (p.length === 3 && p.every(x => /^\d+$/.test(x))) return ok(ano(+p[2]), +p[1], +p[0]);
  if (p.length === 2 && p.every(x => /^\d+$/.test(x))) { const y = ano(+p[1]), mo = +p[0]; return ok(y, mo, mo >= 1 && mo <= 12 ? ult(y, mo) : 1); }
  const d = s.replace(/\D/g, '');
  if (d.length === 6) return ok(ano(+d.slice(4)), +d.slice(2, 4), +d.slice(0, 2));
  if (d.length === 8) return ok(+d.slice(4), +d.slice(2, 4), +d.slice(0, 2));
  if (d.length === 4) { const y = ano(+d.slice(2)), mo = +d.slice(0, 2); return ok(y, mo, mo >= 1 && mo <= 12 ? ult(y, mo) : 1); }
  return null;
}

function diasAte(iso) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(hoje + 'T00:00:00Z')) / 864e5);
}

// Endereço GÔNDOLA-LADO-PRATELEIRA (mesma regra do servidor)
// gôndolas que são áreas livres com pallets (sacarias etc.); vem de /api/config e /api/mapa
let AREAS = [19];
const setAreas = l => { AREAS = (l || [19]).map(Number); };

function parseEndereco(e) {
  e = String(e || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[–—_.\/]/g, '-');
  let m;
  if (!e) return { valido: false, texto: '' };
  const ok = (g, l, n) => ({ valido: g >= 1 && g <= 40 && (n === null || (n >= 1 && n <= 10)) && (/^[AB]$/.test(l) || (g === 9 || g === 10 ? /^P[ED]$/ : /^[FC]$/).test(l)), gondola: g, lado: l, nivel: n });
  if ((m = e.match(/^(\d{1,2})$/)) && AREAS.includes(+m[1])) return { valido: true, gondola: +m[1], lado: null, nivel: null };
  if ((m = e.match(/^(\d{1,2})-P(\d{1,2})$/)) && AREAS.includes(+m[1])) return { valido: +m[2] >= 1 && +m[2] <= 40, gondola: +m[1], lado: 'P', nivel: +m[2] };
  if ((m = e.match(/^(\d{1,2})-(F|C|PE|PD)$/))) return ok(+m[1], m[2], null);
  if ((m = e.match(/^(\d{1,2})-(F|C|PE|PD)-(\d)$/))) return ok(+m[1], m[2], +m[3]);
  if ((m = e.match(/^(\d{1,2})-([AB])-(\d)$/))) return ok(+m[1], m[2], +m[3]);
  return { valido: false, texto: e };
}
const LADO_TXT = { A: 'lado A', B: 'lado B', F: 'ponta da frente', C: 'ponta das costas', PE: 'ponta esquerda', PD: 'ponta direita', P: 'pallet' };
const ladosDe = g => (AREAS.includes(+g) ? ['P'] : +g === 9 || +g === 10 ? ['A', 'B', 'PE', 'PD'] : ['A', 'B', 'F', 'C']);
function descEndereco(e) {
  const p = parseEndereco(e);
  if (!p.gondola) return '';
  return `Gôndola ${p.gondola} · ${LADO_TXT[p.lado]}${p.nivel ? (p.lado === 'P' ? ' ' : ' · prateleira ') + p.nivel : ''}`;
}

const pill = (status, cor) => `<span class="pill" style="--c:${esc(cor || '#6e6e73')}">${esc(status)}</span>`;
const addr = (e, ok = true) => `<span class="addr${ok === false ? ' bad' : ''}" title="${esc(descEndereco(e) || 'fora do padrão')}">${esc(e || 'sem endereço')}</span>`;
