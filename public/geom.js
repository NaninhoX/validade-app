'use strict';
// Geometria pura do editor do mapa (sem DOM): tamanho da gôndola derivado das medidas em cm, alinhar, distribuir,
// agrupar em linhas/colunas e organizar (espaçamento igual, grade). No navegador vira o global `Geom`; no Node, module.exports (testes).
// Convenção: um retângulo é { id, x, y, w, h } em pixels do mapa; escala = pixels do mapa por centímetro.
const Geom = (() => {
  const r1 = v => Math.round(v * 10) / 10;
  const limita = (v, a, b) => Math.max(a, Math.min(b, v));
  const media = a => a.reduce((s, v) => s + v, 0) / a.length;
  const EPS = 0.05;

  // ---------- medidas: caixa derivada dos centímetros ----------
  const DIM0 = { modulo_c: 140, modulo_l: 40, ponta_c: 100, ponta_p: 40 };
  const ladosDe = cfg => (cfg && cfg.lados === 'A' ? ['A'] : cfg && cfg.lados === 'B' ? ['B'] : ['B', 'A']);

  // comprimento L e profundidade T (cm) de uma gôndola (módulos + duas pontas) ou de uma área livre (sacaria)
  function geometria({ area, cfg, padrao }) {
    cfg = cfg || {};
    if (area) return { area: true, L: cfg.c || 600, T: cfg.l || 400 };
    const D = { ...DIM0, ...(padrao || {}), ...(cfg.dim || {}) }, n = cfg.modulos || 5, lados = ladosDe(cfg);
    return { area: false, D, n, lados, L: 2 * D.ponta_p + n * D.modulo_c, T: Math.max(lados.length * D.modulo_l, D.ponta_c) };
  }

  // caixa em pixels do mapa: gôndolas giradas (rot 90) trocam comprimento e profundidade
  function tamanhoCaixa(geo, rot, escala) {
    const vert = rot === 90, aw = vert ? geo.T : geo.L, ah = vert ? geo.L : geo.T;
    return { w: aw * escala, h: ah * escala, aw, ah };
  }

  // escala (px/cm) típica de um layout antigo: mediana de quanto cada caixa antiga cabia em suas medidas reais
  function medianaEscala(itens, padrao = 0.2) {
    const ks = itens.map(i => Math.min(i.w / i.aw, i.h / i.ah)).filter(k => isFinite(k) && k > 0).sort((a, b) => a - b);
    if (!ks.length) return padrao;
    const m = ks.length >> 1, k = ks.length % 2 ? ks[m] : (ks[m - 1] + ks[m]) / 2;
    return Math.round(k * 10000) / 10000;
  }

  // Grava em cada g.w/g.h o tamanho derivado das medidas (formato antigo continua legível). Altera o layout recebido.
  function sincronizaCaixas(layout, geoDe) {
    for (const g of layout.gondolas) { const c = tamanhoCaixa(geoDe(g.id), g.rot, layout.escala); g.w = r1(c.w); g.h = r1(c.h); }
    return layout;
  }

  // Migração transparente: layout sem `escala` (w/h fixos) ganha a escala mediana; cada gôndola passa a ter a caixa derivada, mantendo o centro.
  // Devolve { layout, migrou }. Não altera o original.
  function migrarLayout(layout, geoDe) {
    if (layout && layout.escala > 0) return { layout, migrou: false };
    const L = JSON.parse(JSON.stringify(layout));
    const itens = L.gondolas.filter(g => !geoDe(g.id).area).map(g => { const c = tamanhoCaixa(geoDe(g.id), g.rot, 1); return { w: g.w, h: g.h, aw: c.w, ah: c.h }; });
    L.escala = medianaEscala(itens);
    for (const g of L.gondolas) {
      const cx = g.x + g.w / 2, cy = g.y + g.h / 2, c = tamanhoCaixa(geoDe(g.id), g.rot, L.escala);
      g.w = r1(c.w); g.h = r1(c.h);
      g.x = r1(limita(cx - c.w / 2, 0, Math.max(0, L.largura - c.w))); g.y = r1(limita(cy - c.h / 2, 0, Math.max(0, L.altura - c.h)));
    }
    return { layout: L, migrou: true };
  }

  const pxParaM = (px, escala) => px / escala / 100;
  const mParaPx = (m, escala) => m * 100 * escala;

  // ---------- retângulos ----------
  const caixaDe = rs => {
    const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
    return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
  };
  const cx = r => r.x + r.w / 2, cy = r => r.y + r.h / 2;
  const sobrepoe = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

  // desloca o grupo sem sair do limite
  function limitaGrupo(rs, dx, dy, lim) {
    const b = caixaDe(rs);
    return { dx: limita(dx, lim.x - b.x, lim.x + lim.w - b.x - b.w), dy: limita(dy, lim.y - b.y, lim.y + lim.h - b.y - b.h) };
  }

  // ---------- alinhar e distribuir ----------
  // modo: esq | centro | dir | topo | meio | base — em relação à caixa da seleção. Devolve [{ id, x, y }].
  function alinhar(rs, modo) {
    if (!rs.length) return [];
    const b = caixaDe(rs);
    return rs.map(r => {
      let x = r.x, y = r.y;
      if (modo === 'esq') x = b.x; else if (modo === 'dir') x = b.x + b.w - r.w; else if (modo === 'centro') x = b.x + b.w / 2 - r.w / 2;
      else if (modo === 'topo') y = b.y; else if (modo === 'base') y = b.y + b.h - r.h; else if (modo === 'meio') y = b.y + b.h / 2 - r.h / 2;
      return { id: r.id, x: r1(x), y: r1(y) };
    });
  }

  // eixo 'h' (esquerda para a direita) ou 'v': mantém os dois extremos e iguala os vãos. Precisa de 3 ou mais.
  function distribuir(rs, eixo) {
    if (rs.length < 3) return { ok: false, motivo: 'Distribuir precisa de 3 ou mais gôndolas', pos: [] };
    const h = eixo === 'h', ini = r => (h ? r.x : r.y), tam = r => (h ? r.w : r.h);
    const o = [...rs].sort((a, b) => ini(a) - ini(b) || a.id - b.id), a = o[0], z = o[o.length - 1];
    const vao = (ini(z) + tam(z) - ini(a) - o.reduce((s, r) => s + tam(r), 0)) / (o.length - 1);
    if (vao < -EPS) return { ok: false, motivo: 'Não há espaço entre os extremos para distribuir sem sobrepor', pos: [] };
    let c = ini(a);
    const pos = o.map(r => { const p = { id: r.id, x: h ? r1(c) : r.x, y: h ? r.y : r1(c) }; c += tam(r) + vao; return p; });
    return { ok: true, vao: r1(vao), pos };
  }

  // ---------- agrupar em linhas/colunas ----------
  // valores 1D -> grupos (listas de índices) em que cada valor está a no máximo `tol` do vizinho; do menor para o maior
  function agrupar(vals, tol) {
    const ix = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b] || a - b), out = [];
    for (const i of ix) {
      const g = out[out.length - 1];
      if (g && vals[i] - vals[g[g.length - 1]] <= tol) g.push(i); else out.push([i]);
    }
    return out;
  }
  const linhasDe = (rs, tol) => agrupar(rs.map(cy), tol).map(g => g.map(i => rs[i]).sort((a, b) => a.x - b.x));
  const colunasDe = (rs, tol) => agrupar(rs.map(cx), tol).map(g => g.map(i => rs[i]).sort((a, b) => a.y - b.y));

  // ---------- validação de um plano ----------
  // todos: todas as gôndolas; pos: [{id,x,y}] das que mudam; lim: perímetro {x,y,w,h}
  function valida(todos, pos, lim) {
    const orig = new Map(todos.map(r => [r.id, r]));
    const mov = new Map(pos.filter(p => { const o = orig.get(p.id); return !o || Math.abs(o.x - p.x) > EPS || Math.abs(o.y - p.y) > EPS; }).map(p => [p.id, p]));   // quem não saiu do lugar não conta
    const fim = todos.map(r => (mov.has(r.id) ? { ...r, x: mov.get(r.id).x, y: mov.get(r.id).y } : r));
    for (const r of fim) {
      if (!mov.has(r.id)) continue;
      if (r.x < lim.x - EPS || r.y < lim.y - EPS || r.x + r.w > lim.x + lim.w + EPS || r.y + r.h > lim.y + lim.h + EPS) return { ok: false, motivo: `A gôndola ${r.id} sairia do perímetro da loja` };
    }
    for (let i = 0; i < fim.length; i++) for (let j = i + 1; j < fim.length; j++) {
      if ((mov.has(fim[i].id) || mov.has(fim[j].id)) && sobrepoe(fim[i], fim[j])) return { ok: false, motivo: `As gôndolas ${fim[i].id} e ${fim[j].id} ficariam sobrepostas` };
    }
    return { ok: true };
  }

  // ---------- organizar ----------
  // Modo 1: alinha o centro de cada linha (e de cada coluna) com o centro médio do grupo. Mantém a ordem.
  function planoAlinhar(rs, { tol }) {
    if (rs.length < 2) return { ok: false, motivo: 'Selecione ao menos 2 gôndolas', pos: [] };
    const p = new Map(rs.map(r => [r.id, { id: r.id, x: r.x, y: r.y }]));
    for (const l of linhasDe(rs, tol)) if (l.length > 1) { const m = media(l.map(cy)); for (const r of l) p.get(r.id).y = r1(m - r.h / 2); }
    for (const c of colunasDe(rs, tol)) if (c.length > 1) { const m = media(c.map(cx)); for (const r of c) p.get(r.id).x = r1(m - r.w / 2); }
    return { ok: true, pos: [...p.values()] };
  }

  // Modo 2: mantém linhas e ordem; iguala os corredores entre gôndolas (dentro das linhas) e entre linhas, usando a média dos atuais.
  function planoEspacamento(rs, { tol, gapMin = 0 }) {
    if (rs.length < 2) return { ok: false, motivo: 'Selecione ao menos 2 gôndolas', pos: [] };
    const linhas = linhasDe(rs, tol), hs = [], vs = [];
    const faixa = l => ({ top: Math.min(...l.map(r => r.y)), bot: Math.max(...l.map(r => r.y + r.h)) });
    for (const l of linhas) for (let i = 1; i < l.length; i++) { const g = l[i].x - (l[i - 1].x + l[i - 1].w); if (g > EPS) hs.push(g); }
    for (let i = 1; i < linhas.length; i++) { const g = faixa(linhas[i]).top - faixa(linhas[i - 1]).bot; if (g > EPS) vs.push(g); }
    const gH = Math.max(gapMin, hs.length ? media(hs) : gapMin), gV = Math.max(gapMin, vs.length ? media(vs) : gapMin);
    const pos = []; let cur = faixa(linhas[0]).top;
    for (const l of linhas) {
      const f = faixa(l); let xr = null;
      for (const r of l) {
        const x = xr === null ? r.x : xr + gH;
        pos.push({ id: r.id, x: r1(x), y: r1(cur + (r.y - f.top)) });
        xr = x + r.w;
      }
      cur += f.bot - f.top + gV;
    }
    return { ok: true, pos, gapH: r1(gH), gapV: r1(gV) };
  }

  // área que sobra do perímetro depois de reservar uma faixa livre para a entrada ('baixo'|'cima'|'esq'|'dir', tam em px)
  function areaLivre(lim, entrada) {
    const a = { ...lim };
    if (!entrada || !(entrada.tam > 0)) return a;
    const t = Math.min(entrada.tam, (entrada.lado === 'esq' || entrada.lado === 'dir' ? lim.w : lim.h) - 1);
    if (entrada.lado === 'cima') { a.y += t; a.h -= t; } else if (entrada.lado === 'baixo') a.h -= t;
    else if (entrada.lado === 'esq') { a.x += t; a.w -= t; } else if (entrada.lado === 'dir') a.w -= t;
    return a;
  }

  // posiciona n células de tamanhos `tams` em um eixo de comprimento `total`, com corredores iguais.
  // bordas: corredor também nas duas pontas (a grade ocupa a área toda); senão a grade fica centrada, grudada só entre as células.
  function eixo(tams, total, bordas, gapMin, gapMax) {
    const soma = tams.reduce((s, v) => s + v, 0), n = tams.length, vaos = n - 1 + (bordas ? 2 : 0);
    if (!vaos) return { ok: soma <= total + EPS, gap: 0, ini: (total - soma) / 2, falta: soma - total };
    const gap = Math.min(gapMax, (total - soma) / vaos);
    return { ok: gap >= gapMin - EPS, gap, ini: (total - soma - (n - 1) * Math.max(gap, 0)) / 2, falta: soma + vaos * gapMin - total };
  }

  // Modo 3: grade ordenada pelo número da gôndola, corredores iguais. colunas 0 = escolhe a que melhor cabe.
  function planoGrade(rs, { area, bordas = true, colunas = 0, gapMin = 0, gapMax = Infinity }) {
    if (rs.length < 2) return { ok: false, motivo: 'Selecione ao menos 2 gôndolas', pos: [] };
    const o = [...rs].sort((a, b) => a.id - b.id), n = o.length;
    const monta = nc => {
      const nl = Math.ceil(n / nc), cel = (i, j) => o[i * nc + j];
      const larg = Array.from({ length: nc }, (_, j) => Math.max(0, ...Array.from({ length: nl }, (_, i) => (cel(i, j) ? cel(i, j).w : 0))));
      const alt = Array.from({ length: nl }, (_, i) => Math.max(0, ...Array.from({ length: nc }, (_, j) => (cel(i, j) ? cel(i, j).h : 0))));
      const ex = eixo(larg, area.w, bordas, gapMin, gapMax), ey = eixo(alt, area.h, bordas, gapMin, gapMax);
      return { nc, nl, larg, alt, ex, ey, ok: ex.ok && ey.ok };
    };
    let g = null;
    if (colunas > 0) g = monta(Math.min(colunas, n));
    else {
      const todos = Array.from({ length: n }, (_, i) => monta(i + 1)), bons = todos.filter(t => t.ok);
      const nota = t => Math.min(isFinite(t.ex.gap) && t.nc > 1 ? t.ex.gap : Infinity, isFinite(t.ey.gap) && t.nl > 1 ? t.ey.gap : Infinity);
      g = bons.length ? bons.reduce((m, t) => (nota(t) > nota(m) + EPS ? t : m)) : todos.reduce((m, t) => (Math.max(t.ex.falta, t.ey.falta) < Math.max(m.ex.falta, m.ey.falta) ? t : m));
    }
    if (!g.ok) {
      const falta = Math.max(g.ex.falta, g.ey.falta);
      return { ok: false, colunas: g.nc, linhas: g.nl, falta: r1(falta), motivo: `Não cabe${colunas > 0 ? ` com ${g.nc} coluna${g.nc > 1 ? 's' : ''}` : ''}: faltam ${r1(falta)} px para manter os corredores mínimos`, pos: [] };
    }
    const xs = [], ys = [];
    let x = area.x + g.ex.ini, y = area.y + g.ey.ini;
    for (let j = 0; j < g.nc; j++) { xs.push(x); x += g.larg[j] + g.ex.gap; }
    for (let i = 0; i < g.nl; i++) { ys.push(y); y += g.alt[i] + g.ey.gap; }
    const pos = o.map((r, k) => { const i = Math.floor(k / g.nc), j = k % g.nc; return { id: r.id, x: r1(xs[j] + (g.larg[j] - r.w) / 2), y: r1(ys[i] + (g.alt[i] - r.h) / 2) }; });
    return { ok: true, pos, colunas: g.nc, linhas: g.nl, gapH: r1(g.ex.gap), gapV: r1(g.ey.gap) };
  }

  // ---------- numeração e cópia ----------
  // próximo número livre: de 20 a 40 primeiro (como ao desenhar), depois 1 a 19
  function proximoLivre(ocupados, max = 40) {
    for (let n = 20; n <= max; n++) if (!ocupados.has(n)) return n;
    for (let n = 1; n < 20; n++) if (!ocupados.has(n)) return n;
    return null;
  }

  // cópia da configuração de uma gôndola: lados, módulos, medidas, nomes dos módulos e pallets. Responsáveis (setores) ficam de fora de propósito.
  function copiaCfg(c) {
    const o = {};
    for (const k of ['tipo', 'nome', 'frente', 'lados', 'modulos', 'c', 'l']) if (c && c[k] !== undefined) o[k] = c[k];
    if (c && c.dim) o.dim = { ...c.dim };
    if (c && c.nomes) o.nomes = { ...c.nomes };
    if (c && Array.isArray(c.pallets)) o.pallets = c.pallets.map(p => ({ ...p }));
    return o;
  }

  return { DIM0, geometria, tamanhoCaixa, medianaEscala, sincronizaCaixas, migrarLayout, pxParaM, mParaPx, caixaDe, sobrepoe, limitaGrupo, alinhar, distribuir, agrupar, linhasDe, colunasDe, valida, planoAlinhar, planoEspacamento, areaLivre, planoGrade, proximoLivre, copiaCfg, limita, r1 };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Geom;
