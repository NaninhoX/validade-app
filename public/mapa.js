'use strict';
// Mapa de calor da loja: planta (gôndolas) + detalhe por lado e prateleira. A planta é editável (arrastar/redimensionar) por administradores.
const Mapa = (() => {
  const M = { vista: 'planta', data: null, metric: 'risco', sel: null, shelf: null, selSeta: null, edit: false, editG: false, draftG: null, draftDim: null, draft: null, view: null, ctx: null, ro: null };

  // ---------- cores ----------
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  function rampa(stops, t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]; return mix(hex(c0), hex(c1), (t - t0) / (t1 - t0)); }
    return hex(stops[stops.length - 1][1]);
  }
  const RISCO = [[0, '#7ccf9a'], [.35, '#f3d25c'], [.7, '#f59e42'], [1, '#e5384f']];
  const OCUP = [[0, '#d6e6ff'], [1, '#0a58d6']];
  const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const tinta = c => ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 150 ? '#14161a' : '#ffffff');

  const METRICAS = {
    risco: { nome: 'Risco', desc: 'valor em estoque que já está em alerta ou vencido', ramp: RISCO, leg: ['sem risco', 'alto risco'] },
    status: { nome: 'Validade', desc: 'pior status de validade presente', ramp: null },
    ocup: { nome: 'Ocupação', desc: 'quantidade de itens guardados', ramp: OCUP, leg: ['poucos itens', 'muitos itens'] },
    ronda: { nome: 'Ronda', desc: 'há quantos dias o endereço foi contado', ramp: RISCO, leg: ['contado há pouco', 'sem contar há 60+ dias'] },
  };

  function maximos() {
    const g = M.data.gondolas;
    const cel = g.flatMap(x => x.celulas);
    return { risco: Math.max(1, ...g.map(x => x.risco)), ocup: Math.max(1, ...g.map(x => x.qtd)), cRisco: Math.max(1, ...cel.map(x => x.risco)), cOcup: Math.max(1, ...cel.map(x => x.qtd)) };
  }

  // cor e texto de uma gôndola (ou prateleira) para a métrica atual
  function calor(x, nivelCelula) {
    const mx = maximos();
    if (!x || !x.lotes) return { vazio: true };
    let c, txt;
    switch (M.metric) {
      case 'status': c = hex(x.cor || '#94a3b8'); txt = x.pior; break;
      case 'ocup': c = rampa(OCUP, Math.sqrt(x.qtd / (nivelCelula ? mx.cOcup : mx.ocup))); txt = int(x.qtd) + ' un'; break;
      case 'ronda': {
        const d = x.dias_sem_ronda;
        c = d === null || d === undefined ? hex('#7c6bd6') : rampa(RISCO, d / 60);
        txt = d === null || d === undefined ? 'nunca' : d + ' d'; break;
      }
      default: c = rampa(RISCO, x.risco ? Math.max(.12, Math.sqrt(x.risco / (nivelCelula ? mx.cRisco : mx.risco))) : 0); txt = x.risco ? brlK(x.risco) : 'ok';
    }
    return { bg: rgb(c), ink: tinta(c), txt };
  }

  const enderecoDe = (g, chave) => (chave === 'geral' ? String(g) : `${g}-${chave}`);

  // ---------- geometria das gôndolas (medidas reais em cm) ----------
  // Visão aérea: lado B é a metade de cima, lado A a de baixo; módulos em fila, uma ponta em cada extremo.
  // Gôndolas 1–8: Frente (F) à direita, Costas (C) à esquerda. 11 em diante: o contrário. 9 e 10: PE à esquerda, PD à direita.
  // O módulo 1 é sempre o mais perto da Frente (ou da PE). Sacaria (19) é uma área livre com pallets.
  const U_NIVEIS = 10;
  const PE_PD = id => id === 9 || id === 10;
  const SACARIA = id => (cfgTodas()[id] && cfgTodas()[id].tipo ? cfgTodas()[id].tipo === 'area' : id === 19);
  const rotuloG = id => (cfgTodas()[id] && cfgTodas()[id].nome) || `Gôndola ${id}`;
  const pontasDe = id => (!PE_PD(id) && cfgTodas()[id] && cfgTodas()[id].frente ? (cfgTodas()[id].frente === 'E' ? { esq: 'F', dir: 'C' } : { esq: 'C', dir: 'F' }) : PE_PD(id) ? { esq: 'PE', dir: 'PD' } : id <= 8 ? { esq: 'C', dir: 'F' } : { esq: 'F', dir: 'C' });
  const NOME_LADO = { A: 'Lado A', B: 'Lado B', F: 'Frente', C: 'Costas', PE: 'Ponta esquerda', PD: 'Ponta direita', P: 'Sacaria' };
  const DIM0 = { modulo_c: 140, modulo_l: 40, ponta_c: 100, ponta_p: 40 };
  const dim = () => (M.edit && M.draftDim) || M.data.dimensoes || DIM0;
  const cfgTodas = () => (M.editG && M.draftG) || M.data.gondolas_cfg || {};
  const cfgG = id => cfgTodas()[id] || {};
  const dimG = id => ({ ...dim(), ...(cfgG(id).dim || {}) });
  const ladosG = id => (cfgG(id).lados === 'A' ? ['A'] : cfgG(id).lados === 'B' ? ['B'] : ['B', 'A']);    // de cima para baixo
  const nMod = id => cfgG(id).modulos || 5;
  const frenteNaEsquerda = id => ['F', 'PE'].includes(pontasDe(id).esq);
  const colunaDoModulo = (id, n) => (frenteNaEsquerda(id) ? n - 1 : nMod(id) - n);     // posição (0 = esquerda) do módulo n
  function geomG(id) {
    if (SACARIA(id)) { const c = cfgG(id); return { area: true, L: c.c || 600, T: c.l || 400 }; }
    const D = dimG(id), n = nMod(id);
    return { D, n, L: 2 * D.ponta_p + n * D.modulo_c, T: Math.max(ladosG(id).length * D.modulo_l, D.ponta_c) };
  }
  const setor = (g, lado) => ((M.data.setores || {})[g] || {})[lado] || { nome: '', resp: [] };
  const bonito = n => n.charAt(0) + n.slice(1).toLowerCase();
  const respTxt = s => s.resp.map(bonito).join(', ');
  // todos os responsáveis de uma gôndola (união dos lados), para os cartões pequenos
  const respGondola = id => [...new Set(Object.values((M.data.setores || {})[id] || {}).flatMap(s => s.resp))].map(bonito).join(', ');

  // caixa realmente desenhada dentro do retângulo g.x/y/w/h da planta, respeitando a proporção real
  function caixa(g) {
    const { L, T } = geomG(g.id), vert = g.rot === 90;
    const aw = vert ? T : L, ah = vert ? L : T;
    const k = Math.min(g.w / aw, g.h / ah), w = aw * k, h = ah * k;
    return { x: g.x + (g.w - w) / 2, y: g.y + (g.h - h) / 2, w, h, aw, ah };
  }
  const celulaPonta = (d, lado) => (d ? d.celulas.find(c => c.chave === lado) || d.celulas.find(c => c.lado === lado && c.tipo !== 'face') || null : null);

  // desenha os retângulos (em cm) de uma gôndola; `texto` liga números e rótulos (visão detalhada)
  function formas(id, d, { texto, ox = 0, oy = 0 }) {
    const gm = geomG(id);
    const cel = (chave, x, y, w, h, rotulo, nome, ponta) => {
      const c = chave && d ? d.celulas.find(z => z.chave === chave) : null;
      const k = calor(c, true);
      const sel = M.shelf && M.shelf.g === id && M.shelf.chave === chave;
      const estilo = c && !k.vazio ? `style="fill:${k.bg}"` : '';
      let t = '';
      if (texto) {
        const cor = c && !k.vazio ? k.ink : 'var(--faint)';
        t = `<text x="${x + 6}" y="${y + 14}" font-size="${ponta ? 13 : 11}" font-weight="700" fill="${cor}" opacity=".85">${esc(rotulo)}</text>`;
        if (!ponta) {
          if (nome) t += `<text x="${x + w - 6}" y="${y + 13}" text-anchor="end" font-size="10" fill="${cor}" opacity=".9">${esc(nome.length > 22 ? nome.slice(0, 21) + '…' : nome)}</text>`;
          t += c ? `<text x="${x + w / 2}" y="${y + h / 2 + 1}" text-anchor="middle" font-size="14" font-weight="700" fill="${cor}">${esc(c.pior || '')}</text>
            <text x="${x + w / 2}" y="${y + h - 6}" text-anchor="middle" font-size="10.5" fill="${cor}">${c.lotes} lote${c.lotes > 1 ? 's' : ''} · ${esc(k.txt)}</text>`
            : `<text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" font-size="12" fill="var(--faint)">sem lotes</text>`;
        }
      }
      return `<g class="mp-cel${c ? '' : ' vazia'}${sel ? ' sel' : ''}"${chave && c ? ` data-chave="${esc(chave)}" tabindex="0" role="button" aria-label="${esc(enderecoDe(id, chave))}"` : ''}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${estilo}/>${t}</g>`;
    };
    if (gm.area) {   // sacaria: área livre; pallets cadastrados viram módulos
      const cf = cfgG(id), geral = d ? d.celulas.find(z => z.chave === 'geral') : null, kg = calor(geral, true);
      let s = `<g class="mp-cel${geral ? '' : ' vazia'}${M.shelf && M.shelf.g === id && M.shelf.chave === 'geral' ? ' sel' : ''}"${geral ? ' data-chave="geral" tabindex="0" role="button"' : ''}><rect x="${ox}" y="${oy}" width="${gm.L}" height="${gm.T}" rx="6" ${geral && !kg.vazio ? `style="fill:${kg.bg}"` : ''}/>${texto ? `<text x="${ox + 10}" y="${oy + 20}" font-size="13" font-weight="700" fill="var(--faint)">Sacaria${geral ? ' · sem pallet definido: ' + geral.lotes + ' lotes' : ''}</text>` : ''}</g>`;
      for (const p of cf.pallets || []) s += cel(`P${p.id}`, ox + p.x, oy + p.y, p.c, p.l, `P${p.id}`, p.nome, false);
      return s;
    }
    const { D, n, T } = gm, lados = ladosG(id), pt = pontasDe(id), nomes = cfgG(id).nomes || {};
    const yBase = oy + (T - lados.length * D.modulo_l) / 2, yPonta = oy + (T - D.ponta_c) / 2;
    let s = '';
    for (let m = 1; m <= n; m++) {
      const x = ox + D.ponta_p + colunaDoModulo(id, m) * D.modulo_c;
      lados.forEach((lado, k) => { s += cel(`${lado}-${m}`, x, yBase + k * D.modulo_l, D.modulo_c, D.modulo_l, String(m), nomes[`${lado}-${m}`], false); });
    }
    const xDir = ox + D.ponta_p + n * D.modulo_c;
    const pe = celulaPonta(d, pt.esq), pd = celulaPonta(d, pt.dir);
    s += cel(pe && pe.chave, ox, yPonta, D.ponta_p, D.ponta_c, pt.esq, '', true) + cel(pd && pd.chave, xDir, yPonta, D.ponta_p, D.ponta_c, pt.dir, '', true);
    return s;
  }

  // desenho pequeno da planta (gira 90° nas gôndolas verticais)
  function svgPlanta(g, d) {
    const { L, T } = geomG(g.id), vert = g.rot === 90;
    return `<svg viewBox="0 0 ${vert ? T : L} ${vert ? L : T}" width="100%" height="100%" aria-hidden="true">${vert ? `<g transform="translate(${T} 0) rotate(90)">` : '<g>'}${formas(g.id, d, { texto: false })}</g></svg>`;
  }

  // visão aérea ampliada (ao clicar na gôndola): nomes e responsáveis de cada lado, módulos clicáveis
  function svgDetalhe(id) {
    const gm = geomG(id), d = M.data.gondolas.find(g => g.id === id), p = pontasDe(id);
    const mx = 12, my = 62, W = gm.L + mx * 2, H = gm.T + my * 2;
    const rot = (lado, x, y, anchor) => {
      const s = setor(id, lado);
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="15" font-weight="700" fill="var(--ink)">${esc(NOME_LADO[lado])}${s.nome ? ' · ' + esc(s.nome) : ''}</text>` +
        (s.resp.length ? `<text x="${x}" y="${y + 17}" text-anchor="${anchor}" font-size="12.5" fill="var(--muted)">${esc(respTxt(s))}</text>` : '');
    };
    const ponta = (lado, x, anchor) => {
      const s = setor(id, lado);
      return `<text x="${x}" y="${my + gm.T + 24}" text-anchor="${anchor}" font-size="13" font-weight="700" fill="var(--ink)">${esc(lado)}${s.nome ? ' · ' + esc(s.nome) : ''}</text>` +
        (s.resp.length ? `<text x="${x}" y="${my + gm.T + 40}" text-anchor="${anchor}" font-size="11.5" fill="var(--muted)">${esc(respTxt(s))}</text>` : '');
    };
    const lados = gm.area ? [] : ladosG(id);
    return `<svg class="mp-det" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(rotuloG(id))} vista de cima">
      ${formas(id, d, { texto: true, ox: mx, oy: my })}
      ${gm.area ? rot('P', W / 2, my - 30, 'middle') : (lados.includes('B') ? rot('B', W / 2, my - 30, 'middle') : '') + (lados.includes('A') ? rot('A', W / 2, my + gm.T + 24, 'middle') : '')}
      ${gm.area ? '' : ponta(p.esq, mx, 'start') + ponta(p.dir, W - mx, 'end')}
    </svg>`;
  }

  // ---------- planta ----------
  // No celular a planta não encolhe até ficar ilegível: tem escala mínima e rola para os lados.
  const escala = (largPalco, L) => Math.max(largPalco / L.largura, largPalco < 760 ? 0.62 : 0);
  const rolaParaDetalhe = () => { if (innerWidth < 1180) { const l = $('#detalhe') || $('#lateral'); if (l) setTimeout(() => l.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); } };

  function desenhaGrade(stage) {
    const ids = [...new Set([...M.data.layout.gondolas.map(g => g.id), ...M.data.gondolas.map(g => g.id)])].sort((a, b) => a - b);
    const porId = new Map(M.data.gondolas.map(g => [g.id, g]));
    stage.innerHTML = '<div class="gridview">' + ids.map((id, i) => {
      const d = porId.get(id), h = calor(d, false), r = respGondola(id);
      return '<button class="gt' + (h.vazio ? ' vazia' : '') + (M.sel === id ? ' sel' : '') + '" data-g="' + id + '" style="--i:' + i + ';' + (h.vazio ? '' : '--hc:' + h.bg + ';--hi:' + h.ink) + '" aria-label="Gôndola ' + id + '">' +
        '<span class="n">' + id + '</span>' + (cfgTodas()[id] && cfgTodas()[id].nome ? '<span class="s">' + esc(cfgTodas()[id].nome) + '</span>' : '') + '<span class="t">' + (h.vazio ? 'vazia' : esc(h.txt)) + '</span>' + (d && !h.vazio ? '<span class="s">' + d.lotes + ' lotes</span>' : '') + (r ? '<span class="r">' + esc(r) + '</span>' : '') + (d && d.vencidos ? '<span class="tag">' + d.vencidos + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    $$('.gt', stage).forEach(b => b.addEventListener('click', () => { M.sel = +b.dataset.g; M.shelf = null; desenhaPalco(); desenhaDetalhe(); desenhaLateral(); rolaParaDetalhe(); }));
    const aviso = $('#orfas'); if (aviso) aviso.innerHTML = '';
  }

  function layoutAtual() { return M.edit ? M.draft : M.data.layout; }

  const setaSvg = s => `<svg viewBox="0 0 ${s.c} 24" width="${s.c}" height="24" aria-hidden="true"><line x1="2" y1="12" x2="${s.c - 12}" y2="12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 9"/><path d="M${s.c - 16} 3 L${s.c - 2} 12 L${s.c - 16} 21 Z" fill="currentColor"/></svg>`;

  function desenhaPalco() {
    let L = layoutAtual();
    if (M.editG && M.novasG) {   // gôndolas recém-criadas aparecem já na edição, numa posição provisória
      const extra = [...M.novasG].filter(n => M.draftG[n] && !L.gondolas.some(g => g.id === n));
      if (extra.length) { L = { ...L, gondolas: [...L.gondolas] }; extra.forEach(n => L.gondolas.push(caixaInicial(L, n))); }
    }
    const stage = $('#stage');
    if (!stage) return;
    const grade = M.vista === 'grade' && !M.edit && !M.editG;
    stage.classList.toggle('stage-bare', grade);
    if (grade) { stage.style.height = 'auto'; stage.style.overflowX = ''; return desenhaGrade(stage); }
    const w = stage.clientWidth || 800;
    const s = escala(w, L);
    stage.style.height = (L.altura * s) + 'px';
    stage.style.overflowX = s * L.largura > w + 1 ? 'auto' : 'hidden';
    const porId = new Map(M.data.gondolas.map(g => [g.id, g]));
    const noLayout = new Set(L.gondolas.map(g => g.id));
    stage.innerHTML = `<div class="canvas" id="canvas" style="width:${L.largura}px;height:${L.altura}px;transform:scale(${s})">
      ${L.fundo ? `<div class="bg" style="background-image:url('${esc(L.fundo)}');opacity:${L.fundo_opacidade}"></div>` : ''}
      <div class="grid-bg"></div>
      ${(L.setas || []).map((a, i) => `<div class="seta${M.edit ? ' edit' : ''}${M.edit && M.selSeta === i ? ' sel' : ''}" data-s="${i}" style="left:${a.x}px;top:${a.y - 12}px;width:${a.c}px;transform:rotate(${a.rot}deg)">${setaSvg(a)}</div>`).join('')}
      ${L.gondolas.map((g, i) => {
        const d = porId.get(g.id), c = caixa(g);
        return `<div class="gon${M.sel === g.id ? ' sel' : ''}${M.edit ? ' edit' : ''}" data-g="${g.id}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;--i:${i}" tabindex="0" role="button" aria-label="Gôndola ${g.id}">
          ${svgPlanta(g, d)}<span class="gn">${g.id}${cfgTodas()[g.id] && cfgTodas()[g.id].nome ? ` · ${esc(cfgTodas()[g.id].nome)}` : ''}</span>${d && d.vencidos ? `<span class="tag">${d.vencidos}</span>` : ''}${M.edit && M.sel === g.id ? '<span class="rz" data-rz="1"></span>' : ''}</div>`;
      }).join('')}</div>`;
    const orfas = M.data.gondolas.filter(g => !noLayout.has(g.id));
    const aviso = $('#orfas');
    if (aviso) aviso.innerHTML = orfas.length ? `<div class="callout warn">${ico('alert')}<div>Gôndola(s) <b>${orfas.map(g => g.id).join(', ')}</b> têm estoque mas ainda não estão na planta. ${M.ctx.admin ? 'Use “Editar planta” para posicioná-las.' : ''}</div></div>` : '';
    ligaPalco(s);
  }

  function ligaPalco(s) {
    const tip = $('#tip');
    $$('#canvas .gon').forEach(el => {
      const id = +el.dataset.g;
      el.addEventListener('click', () => { M.selSeta = null; M.sel = id; if (!M.edit) M.shelf = null; desenhaPalco(); desenhaDetalhe(); desenhaLateral(); if (!M.edit && !M.editG) rolaParaDetalhe(); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
      el.addEventListener('mousemove', e => {
        if (M.edit) return;
        const d = M.data.gondolas.find(g => g.id === id);
        const r = respGondola(id);
        tip.innerHTML = d ? `<b>${esc(rotuloG(id))}</b>${r ? ' · ' + esc(r) : ''}<br>${d.lotes} lotes · ${int(d.qtd)} itens<br>Valor ${brl(d.valor)}<br>${d.risco ? 'Em risco ' + brl(d.risco) + '<br>' : ''}Pior: ${esc(d.pior || '—')}${d.nunca_contada ? '<br>Nunca contada' : d.dias_sem_ronda !== null ? '<br>Ronda há ' + d.dias_sem_ronda + ' d' : ''}` : `<b>Gôndola ${id}</b><br>sem estoque`;
        tip.style.left = Math.min(innerWidth - 250, e.clientX + 16) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; tip.classList.add('on');
      });
      el.addEventListener('mouseleave', () => tip.classList.remove('on'));
      if (M.edit) arrasta(el, id, s);
    });
    if (M.edit) $$('#canvas .seta').forEach(el => arrastaSeta(el, +el.dataset.s, s));
  }

  // arrastar / redimensionar (modo edição). Redimensionar mexe só no comprimento: a proporção real é mantida.
  function arrasta(el, id, s) {
    el.addEventListener('pointerdown', e => {
      const g = M.draft.gondolas.find(x => x.id === id);
      const rz = e.target.dataset.rz;
      if (M.sel !== id || M.selSeta !== null) { M.sel = id; M.selSeta = null; desenhaLateral(); }
      const x0 = e.clientX, y0 = e.clientY, gx = g.x, gy = g.y, gw = g.w, gh = g.h;
      const { L, T } = geomG(id), vert = g.rot === 90;
      el.setPointerCapture(e.pointerId);
      const mover = ev => {
        const dx = (ev.clientX - x0) / s, dy = (ev.clientY - y0) / s;
        if (rz) {
          const len = Math.max(60, Math.round(((vert ? gh : gw) + (vert ? dy : dx)) / 5) * 5), curto = Math.round(len * T / L * 10) / 10;
          g.w = vert ? curto : len; g.h = vert ? len : curto;
        } else { g.x = Math.round((gx + dx) / 5) * 5; g.y = Math.round((gy + dy) / 5) * 5; }
        const c = caixa(g);
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.style.width = c.w + 'px'; el.style.height = c.h + 'px';
      };
      const fim = () => { el.removeEventListener('pointermove', mover); el.removeEventListener('pointerup', fim); desenhaPalco(); desenhaLateral(); };
      el.addEventListener('pointermove', mover); el.addEventListener('pointerup', fim);
      e.preventDefault();
    });
  }

  function arrastaSeta(el, i, s) {
    el.addEventListener('pointerdown', e => {
      const a = M.draft.setas[i];
      M.selSeta = i; M.sel = null;
      const x0 = e.clientX, y0 = e.clientY, ax = a.x, ay = a.y;
      el.setPointerCapture(e.pointerId);
      const mover = ev => { a.x = Math.round((ax + (ev.clientX - x0) / s) / 5) * 5; a.y = Math.round((ay + (ev.clientY - y0) / s) / 5) * 5; el.style.left = a.x + 'px'; el.style.top = (a.y - 12) + 'px'; };
      const fim = () => { el.removeEventListener('pointermove', mover); el.removeEventListener('pointerup', fim); desenhaPalco(); desenhaLateral(); };
      el.addEventListener('pointermove', mover); el.addEventListener('pointerup', fim);
      e.preventDefault();
    });
  }

  // ---------- visão aérea da gôndola selecionada ----------
  function desenhaDetalhe() {
    const el = $('#detalhe');
    if (!el) return;
    if (M.edit || M.editG || M.sel === null) { el.innerHTML = ''; el.hidden = true; return; }
    const gm = geomG(M.sel);
    el.hidden = false;
    el.innerHTML = `<div class="card reveal"><div class="head"><div><h2>${esc(rotuloG(M.sel))} · vista de cima</h2><div class="sub">${(gm.L / 100).toLocaleString('pt-BR')} m de comprimento · ${gm.T} cm de largura · toque num módulo para ver os lotes</div></div></div>
      <div class="det-scroll">${svgDetalhe(M.sel)}</div></div>`;
    $$('.mp-cel[data-chave]', el).forEach(c => {
      const abre = () => { M.shelf = { g: M.sel, chave: c.dataset.chave }; desenhaDetalhe(); desenhaLateral(); if (innerWidth < 1180) { const l = $('#lateral'); if (l) setTimeout(() => l.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); } };
      c.addEventListener('click', abre);
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abre(); } });
    });
  }

  // ---------- painel lateral ----------
  function lateralGondola() {
    const g = M.data.gondolas.find(x => x.id === M.sel) || { id: M.sel, lotes: 0, qtd: 0, valor: 0, risco: 0, celulas: [], vazia: true };
    const lados = SACARIA(g.id) ? ['P'] : [...ladosG(g.id), pontasDe(g.id).esq, pontasDe(g.id).dir];
    const resumoLado = lado => {
      const cs = g.celulas.filter(c => c.lado === lado), s = setor(g.id, lado);
      const lotes = cs.reduce((n, c) => n + c.lotes, 0), risco = cs.reduce((n, c) => n + c.risco, 0), venc = cs.reduce((n, c) => n + c.vencidos, 0);
      return `<div class="row" style="grid-template-columns:34px minmax(0,1fr) auto"><b style="font:700 18px var(--font-display);text-align:center">${esc(lado)}</b>
        <div style="min-width:0"><div class="pname">${esc(NOME_LADO[lado])}${s.nome ? ' · ' + esc(s.nome) : ''}</div><div class="xs muted">${s.resp.length ? esc(respTxt(s)) + ' · ' : ''}${lotes} lote${lotes === 1 ? '' : 's'}${venc ? ` · <b style="color:var(--bad)">${venc} vencido${venc > 1 ? 's' : ''}</b>` : ''}</div></div>
        <b class="num">${risco ? brlK(risco) : '—'}</b></div>`;
    };
    const geral = g.celulas.find(c => c.chave === 'geral');
    let itens = '';
    if (M.shelf && M.shelf.g === g.id) {
      const c = g.celulas.find(x => x.chave === M.shelf.chave);
      if (c) itens = `<div class="items"><div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px"><h3>${addr(enderecoDe(g.id, c.chave))} <span class="muted" style="font-weight:500">${c.itens.length} lote${c.itens.length > 1 ? 's' : ''}</span></h3>
        <a href="#/estoque?q=${encodeURIComponent(enderecoDe(g.id, c.chave))}" class="small">Ver no estoque →</a></div>
        ${c.itens.map(it => `<div class="item"><span class="dot" style="--c:${esc(it.cor)}"></span><div style="min-width:0"><div class="pname" style="font-size:13px">${esc(it.nome || it.ean)}</div><div class="xs muted">lote ${esc(it.lote)} · vence ${brData(it.validade)} (${it.dias}d)${it.desconto ? ' · oferta ' + it.desconto + '%' : ''}</div></div><div style="text-align:right">${pill(it.status, it.cor)}<div class="xs muted" style="margin-top:3px">${it.qtd} un</div></div></div>`).join('')}</div>`;
    }
    return `<div class="card drawer">
      <div class="head" style="margin-bottom:10px"><div><h2 style="font-size:20px">${esc(rotuloG(g.id))}</h2><div class="sub">${g.lotes ? `${g.lotes} lotes · ${int(g.qtd)} itens · ${brl(g.valor)}` : 'sem estoque cadastrado'}</div></div>
        <button class="icon subtle" id="fecha" aria-label="Fechar">${ico('x')}</button></div>
      ${g.risco ? `<div class="callout warn" style="margin-bottom:12px">${ico('flame')}<div><b>${brl(g.risco)}</b> em risco${g.vencidos ? ` · <b>${g.vencidos}</b> vencido${g.vencidos > 1 ? 's' : ''}` : ''}${g.nunca_contada ? ' · endereços ainda sem contagem' : g.dias_sem_ronda > 7 ? ` · ronda há ${g.dias_sem_ronda} dias` : ''}</div></div>` : ''}
      <h3 style="margin:2px 0 4px">Setores</h3>${lados.map(resumoLado).join('')}
      ${geral ? `<div style="margin-top:12px"><h3 style="margin-bottom:6px">Sem lado/prateleira definidos</h3><button class="shelf" data-chave="geral" style="--hc:${calor(geral, true).bg};--hi:${calor(geral, true).ink}"><span class="lv">?</span><span><span class="nm">${esc(geral.pior)}</span><br><span class="vl">${geral.lotes} lote${geral.lotes > 1 ? 's' : ''} · ${int(geral.qtd)} un</span></span><span class="vl"></span></button><p class="xs muted" style="margin-top:6px">Esses lotes estão só com o número da gôndola. Na próxima ronda, informe lado e prateleira (ex.: ${g.id}-A-1).</p></div>` : ''}
      ${itens || '<p class="xs muted" style="margin-top:12px">Toque num módulo da vista de cima para ver os lotes dele.</p>'}</div>`;
  }

  function lateralEdicao() {
    const L = M.draft, g = L.gondolas.find(x => x.id === M.sel), a = M.selSeta !== null ? L.setas[M.selSeta] : null;
    const livres = [...new Set([...Array.from({ length: 19 }, (_, i) => i + 1), ...Object.keys(cfgTodas()).map(Number)])].sort((a, b) => a - b).filter(n => !L.gondolas.some(x => x.id === n));
    return `<div class="card drawer"><div class="head"><div><h2>Editar planta</h2><div class="sub">Arraste as gôndolas e as setas; a bolinha azul muda o comprimento (a proporção real é mantida).</div></div></div>
      <div class="grid" style="gap:14px">
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="f">Largura da planta</label><input id="eLarg" type="number" min="400" max="4000" step="50" value="${L.largura}"></div>
          <div><label class="f">Altura da planta</label><input id="eAlt" type="number" min="300" max="4000" step="50" value="${L.altura}"></div></div>
        <div><label class="f">Medidas padrão das prateleiras (cm)</label><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">${CAMPOS_DIM.map(([k, r]) => `<div><label class="xs muted" for="ed_${k}">${r}</label><input id="ed_${k}" data-edim="${k}" type="number" min="10" max="300" value="${dim()[k]}"></div>`).join('')}</div></div>
        <div><button id="eProp">${ico('refresh')} Aplicar proporção real</button><div class="xs muted" style="margin-top:6px">Ajusta cada gôndola às medidas reais e deixa a 9 e a 10 na vertical.</div></div>
        <div><label class="f">Planta da loja (imagem de fundo)</label>
          <div class="editbar"><label class="btn sm" style="cursor:pointer">${ico('image')} Enviar imagem<input id="eFundo" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${L.fundo ? `<button class="sm danger" id="eSemFundo">Remover</button>` : ''}</div>
          ${L.fundo ? `<label class="f" style="margin-top:10px">Transparência da imagem</label><input id="eOp" type="range" min="0" max="1" step="0.05" value="${L.fundo_opacidade}" style="min-height:24px;padding:0">` : ''}</div>
        <div><label class="f">Gôndola selecionada</label>${g ? `<div class="editbar"><b style="font-size:18px">${g.id}</b><button class="sm" id="eGira">${ico('rotate')} Girar</button><button class="sm danger" id="eRemove">${ico('minus')} Tirar da planta</button></div>` : '<p class="small muted">Clique numa gôndola para selecionar.</p>'}</div>
        ${livres.length ? `<div><label class="f">Adicionar gôndola</label><div class="editbar">${livres.map(n => `<button class="sm" data-add="${n}">${n}</button>`).join('')}</div></div>` : ''}
        <div><label class="f">Setas de fluxo (por onde os clientes andam)</label>
          <div class="editbar"><button class="sm" id="eNovaSeta">${ico('plus')} Adicionar seta</button>${a ? `<button class="sm" id="eGiraSeta">${ico('rotate')} Girar 45°</button><button class="sm danger" id="eRemSeta">${ico('minus')} Remover</button>` : ''}</div>
          ${a ? `<label class="f" style="margin-top:10px">Comprimento da seta</label><input id="eSetaC" type="range" min="30" max="400" step="10" value="${a.c}" style="min-height:24px;padding:0">` : '<p class="xs muted" style="margin-top:6px">Clique numa seta para selecionar.</p>'}</div>
        <div class="editbar" style="justify-content:flex-end"><button id="eCancela">Cancelar</button><button class="primary" id="eSalva">${ico('check')} Salvar planta</button></div>
      </div></div>`;
  }

  // ---------- editar gôndolas (lados, módulos, medidas, nomes dos módulos; sacaria = área com pallets) ----------
  const CAMPOS_DIM = [['modulo_c', 'Módulo: comprimento'], ['modulo_l', 'Módulo: profundidade'], ['ponta_c', 'Ponta: largura'], ['ponta_p', 'Ponta: profundidade']];

  function lateralEdicaoG() {
    const idsLayout = new Set(M.data.layout.gondolas.map(g => g.id));
    const ids = [...new Set([...idsLayout, ...M.data.gondolas.map(g => g.id), ...Object.keys(M.draftG).map(Number)])].sort((a, b) => a - b);
    const livres = Array.from({ length: 40 }, (_, i) => i + 1).filter(n => !ids.includes(n));
    const id = M.sel, c = id !== null ? (M.draftG[id] = M.draftG[id] || {}) : null;
    let corpo = '<p class="small muted">Clique numa gôndola do mapa ou escolha na lista.</p>';
    if (id !== null) {
      const area = SACARIA(id);
      const comum = `<div><label class="f" for="gNome">Nome (aparece no mapa)</label><input id="gNome" maxlength="40" placeholder="${area ? 'ex.: Sacaria de cães' : 'ex.: Farmácia'}" value="${esc(c.nome || '')}"></div>
        <div><label class="f">Tipo</label><div class="seg" id="gTipo"><button data-t="gondola" aria-pressed="${!area}">Gôndola com módulos</button><button data-t="area" aria-pressed="${area}">Área livre (pallets)</button></div></div>`;
      let resto;
      if (area) {
        c.pallets = c.pallets || [];
        resto = `<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="f">Comprimento da área (cm)</label><input id="gAreaC" type="number" min="100" max="3000" value="${c.c ?? 600}"></div>
          <div><label class="f">Largura da área (cm)</label><input id="gAreaL" type="number" min="100" max="3000" value="${c.l ?? 400}"></div></div>
        <div><label class="f">Pallets (módulos da área)</label><div class="xs muted" style="margin-bottom:8px">Endereço do pallet: ${id}-P1, ${id}-P2… Posição e tamanho em cm, a partir do canto superior esquerdo da área.</div>
          ${c.pallets.map((p, i) => `<div class="pal" data-i="${i}"><b>P${p.id}</b><input data-k="nome" placeholder="Nome" maxlength="40" value="${esc(p.nome || '')}" aria-label="Nome do pallet ${p.id}">
            ${['x', 'y', 'c', 'l'].map(k => `<label class="xs muted">${{ x: 'X', y: 'Y', c: 'Comp.', l: 'Larg.' }[k]}<input data-k="${k}" type="number" min="0" max="3000" value="${p[k]}"></label>`).join('')}
            <button class="sm danger" data-rem="${i}" aria-label="Remover pallet ${p.id}">${ico('minus')}</button></div>`).join('')}
          <button class="sm" id="gAddPal">${ico('plus')} Adicionar pallet</button></div>`;
      } else {
        const D = dimG(id), lados = ladosG(id), n = nMod(id), nomes = c.nomes || {};
        resto = `<div><label class="f">Lados com prateleira</label><div class="seg" id="gLados"><button data-l="AB" aria-pressed="${lados.length === 2}">A e B</button><button data-l="B" aria-pressed="${lados.length === 1 && lados[0] === 'B'}">Só B (cima)</button><button data-l="A" aria-pressed="${lados.length === 1 && lados[0] === 'A'}">Só A (baixo)</button></div></div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="f" for="gMod">Módulos por lado</label><input id="gMod" type="number" min="1" max="${U_NIVEIS}" value="${n}"></div>
            ${PE_PD(id) ? '' : `<div><label class="f" for="gFrente">Ponta da Frente</label><select id="gFrente"><option value="" ${!c.frente ? 'selected' : ''}>Automática</option><option value="E" ${c.frente === 'E' ? 'selected' : ''}>À esquerda</option><option value="D" ${c.frente === 'D' ? 'selected' : ''}>À direita</option></select></div>`}</div>
          <div><label class="f">Medidas desta gôndola (cm) <span class="muted">— vazio usa o padrão da loja</span></label>
            <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">${CAMPOS_DIM.map(([k, r]) => `<div><label class="xs muted" for="gd_${k}">${r}</label><input id="gd_${k}" data-dim="${k}" type="number" min="10" max="300" placeholder="${dim()[k]}" value="${(c.dim || {})[k] ?? ''}"></div>`).join('')}</div></div>
          <div><label class="f">Nome de cada módulo <span class="muted">(opcional, o módulo 1 fica junto da Frente)</span></label>
            ${lados.map(l => `<div class="xs muted" style="margin:8px 0 4px">${NOME_LADO[l]}</div><div class="nomes-mod">${Array.from({ length: n }, (_, i) => `<input data-nome="${l}-${i + 1}" placeholder="${i + 1}" maxlength="40" value="${esc(nomes[`${l}-${i + 1}`] || '')}" aria-label="Nome do módulo ${i + 1} do ${NOME_LADO[l]}">`).join('')}</div>`).join('')}</div>`;
      }
      corpo = comum + resto + (id >= 19 ? `<div><button class="sm danger" id="gRemove">${ico('minus')} Remover ${esc(rotuloG(id))} do mapa</button></div>` : '');
    }
    const nova = livres.length ? `<details class="nova-g"><summary>${ico('plus')} Nova gôndola ou área</summary>
        <div class="grid" style="grid-template-columns:90px 1fr;gap:10px;margin-top:10px"><div><label class="f" for="gnNum">Número</label><select id="gnNum">${livres.map(n => `<option value="${n}" ${n === Math.max(20, livres[0]) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div><label class="f" for="gnNome">Nome</label><input id="gnNome" maxlength="40" placeholder="ex.: Farmácia, Aquarismo, Ponta de promoção"></div></div>
        <div class="seg" id="gnTipo" style="margin:10px 0"><button data-t="gondola" aria-pressed="true">Gôndola com módulos</button><button data-t="area" aria-pressed="false">Área livre (pallets)</button></div>
        <button class="sm primary" id="gnCria">${ico('plus')} Criar e posicionar no mapa</button></details>` : '';
    return `<div class="card drawer"><div class="head"><div><h2>Editar gôndolas</h2><div class="sub">Lados, módulos, medidas, nomes e novas gôndolas ou áreas. O mapa muda enquanto você edita.</div></div></div>
      <div class="grid" style="gap:14px">
        ${nova}
        <div><label class="f" for="gSel">Gôndola</label><select id="gSel"><option value="">Escolha…</option>${ids.map(i => `<option value="${i}" ${i === id ? 'selected' : ''}>${i} · ${esc(((M.draftG[i] || {}).nome) || (i === 19 ? 'Sacaria de gatos' : 'Gôndola'))}</option>`).join('')}</select></div>
        ${corpo}
        <div class="editbar" style="justify-content:flex-end"><button id="gCancela">Cancelar</button><button class="primary" id="gSalva">${ico('check')} Salvar gôndolas</button></div>
      </div></div>`;
  }

  // posição inicial de uma gôndola nova na planta (embaixo, em fila)
  function caixaInicial(L, id) {
    const { L: comp, T } = geomG(id), vert = PE_PD(id), len = 200, curto = Math.round(len * T / comp * 10) / 10;
    const n = L.gondolas.length;
    return { id, x: 60 + (n % 5) * 190, y: Math.min(L.altura - 60, 60 + Math.floor(n / 5) * 90), w: vert ? curto : len, h: vert ? len : curto, rot: vert ? 90 : 0 };
  }

  function ligaEdicaoG() {
    const id = M.sel, c = id !== null ? M.draftG[id] : null;
    const redesenha = () => desenhaPalco();
    $('#gSel').addEventListener('change', e => { M.sel = e.target.value ? +e.target.value : null; desenhaPalco(); desenhaLateral(); });
    const nova = $('#gnCria');
    if (nova) {
      $('#gnTipo').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) $$('#gnTipo button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
      nova.addEventListener('click', () => {
        const n = +$('#gnNum').value, tipo = $('#gnTipo button[aria-pressed=true]').dataset.t, nome = $('#gnNome').value.trim();
        M.draftG[n] = tipo === 'area' ? { tipo, nome, c: 600, l: 400, pallets: [] } : { tipo, nome, lados: 'AB', modulos: 5, dim: null, nomes: {} };
        M.novasG = M.novasG || new Set(); M.novasG.add(n);
        M.sel = n; desenhaPalco(); desenhaLateral();
      });
    }
    $('#gCancela').addEventListener('click', () => { M.editG = false; M.draftG = null; M.novasG = null; M.removidasG = null; M.sel = null; montaTudo(); });
    $('#gSalva').addEventListener('click', async () => {
      try {
        const L = JSON.parse(JSON.stringify(M.data.layout));
        L.setas = L.setas || [];
        let mexeu = false;
        for (const n of M.removidasG || []) if (L.gondolas.some(g => g.id === n)) { L.gondolas = L.gondolas.filter(g => g.id !== n); mexeu = true; }
        M.data.gondolas_cfg = await api('/api/gondolas', { method: 'PUT', body: M.draftG });
        for (const n of M.novasG || []) if (M.data.gondolas_cfg[n] && !L.gondolas.some(g => g.id === n)) { L.gondolas.push(caixaInicial(L, n)); mexeu = true; }
        if (mexeu) M.data.layout = await api('/api/layout', { method: 'PUT', body: { ...L, provisorio: false } });
        M.data.areas = Object.entries(M.data.gondolas_cfg).filter(([, v]) => v.tipo === 'area').map(([k]) => +k);
        M.editG = false; M.draftG = null; M.novasG = null; M.removidasG = null; toast('Gôndolas salvas', 'ok'); montaTudo();
      } catch (er) { toast(er.message, 'bad', 5000); }
    });
    if (id === null) return;
    $('#gNome').addEventListener('change', e => { c.nome = e.target.value.trim(); desenhaPalco(); });
    $('#gTipo').addEventListener('click', e => {
      const b = e.target.closest('button[data-t]'); if (!b || b.dataset.t === (SACARIA(id) ? 'area' : 'gondola')) return;
      const nome = c.nome || '';
      M.draftG[id] = b.dataset.t === 'area' ? { tipo: 'area', nome, c: 600, l: 400, pallets: [] } : { tipo: 'gondola', nome, lados: 'AB', modulos: 5, dim: null, nomes: {} };
      desenhaPalco(); desenhaLateral();
    });
    const rem = $('#gRemove');
    if (rem) rem.addEventListener('click', () => {
      if (!confirm(`Tirar ${rotuloG(id)} do mapa? Os lotes com esse endereço continuam no estoque.`)) return;
      delete M.draftG[id]; M.removidasG = M.removidasG || new Set(); M.removidasG.add(id); M.sel = null; desenhaPalco(); desenhaLateral();
    });
    if (SACARIA(id)) {
      $('#gAreaC').addEventListener('change', e => { c.c = +e.target.value; redesenha(); });
      $('#gAreaL').addEventListener('change', e => { c.l = +e.target.value; redesenha(); });
      $('#gAddPal').addEventListener('click', () => {
        const usados = new Set(c.pallets.map(p => p.id)); let n = 1; while (usados.has(n)) n++;
        c.pallets.push({ id: n, x: 10 + (c.pallets.length % 5) * 130, y: 10 + Math.floor(c.pallets.length / 5) * 110, c: 120, l: 100, nome: '' });
        desenhaPalco(); desenhaLateral();
      });
      $$('.pal').forEach(row => {
        const p = c.pallets[+row.dataset.i];
        $$('input', row).forEach(inp => inp.addEventListener('change', () => { p[inp.dataset.k] = inp.dataset.k === 'nome' ? inp.value : +inp.value; redesenha(); }));
        $('[data-rem]', row).addEventListener('click', () => { c.pallets.splice(+row.dataset.i, 1); desenhaPalco(); desenhaLateral(); });
      });
      return;
    }
    $$('#gLados button').forEach(b => b.addEventListener('click', () => { c.lados = b.dataset.l; c.nomes = Object.fromEntries(Object.entries(c.nomes || {}).filter(([k]) => c.lados.includes(k[0]))); desenhaPalco(); desenhaLateral(); }));
    $('#gMod').addEventListener('change', e => {
      c.modulos = Math.max(1, Math.min(U_NIVEIS, +e.target.value || 5));
      c.nomes = Object.fromEntries(Object.entries(c.nomes || {}).filter(([k]) => +k.split('-')[1] <= c.modulos));
      desenhaPalco(); desenhaLateral();
    });
    const fr = $('#gFrente'); if (fr) fr.addEventListener('change', e => { c.frente = e.target.value || null; desenhaPalco(); });
    $$('[data-dim]').forEach(inp => inp.addEventListener('change', () => {
      c.dim = c.dim || {};
      if (inp.value === '') delete c.dim[inp.dataset.dim]; else c.dim[inp.dataset.dim] = +inp.value;
      desenhaPalco();
    }));
    $$('[data-nome]').forEach(inp => inp.addEventListener('change', () => { c.nomes = c.nomes || {}; if (inp.value.trim()) c.nomes[inp.dataset.nome] = inp.value.trim(); else delete c.nomes[inp.dataset.nome]; }));
  }

  function desenhaLateral() {
    const el = $('#lateral');
    if (!el) return;
    if (M.editG) { el.innerHTML = lateralEdicaoG(); ligaEdicaoG(); return; }
    if (M.edit) { el.innerHTML = lateralEdicao(); ligaEdicao(); return; }
    if (M.sel === null) {
      const top = [...M.data.gondolas].sort((a, b) => b.risco - a.risco).slice(0, 6);
      const sl = M.data.sem_local;
      el.innerHTML = `<div class="card drawer"><div class="head"><div><h2>Selecione uma gôndola</h2><div class="sub">Clique na planta para ver a gôndola de cima, com cada lado e cada módulo.</div></div></div>
        <h3 style="margin:4px 0 6px">Onde está o maior risco</h3>
        ${top.length ? top.map(g => `<div class="row click" data-g="${g.id}"><span class="dot" style="--c:${esc(g.cor || '#94a3b8')}"></span><div><div class="pname">${esc(rotuloG(g.id))}</div><div class="xs muted">${g.lotes} lotes · ${g.vencidos} vencidos</div></div><b class="num">${brlK(g.risco)}</b></div>`).join('') : '<p class="muted small">Sem estoque mapeado.</p>'}
        ${sl.lotes ? `<div class="callout warn" style="margin-top:14px">${ico('alert')}<div><b>${sl.lotes} lotes</b> sem endereço válido (${sl.enderecos.map(e => esc(e.endereco)).join(', ')}). Ajuste na próxima ronda.</div></div>` : ''}</div>`;
      $$('.row[data-g]', el).forEach(r => r.addEventListener('click', () => { M.sel = +r.dataset.g; desenhaPalco(); desenhaDetalhe(); desenhaLateral(); rolaParaDetalhe(); }));
      return;
    }
    el.innerHTML = lateralGondola();
    $('#fecha', el).addEventListener('click', () => { M.sel = null; M.shelf = null; desenhaPalco(); desenhaDetalhe(); desenhaLateral(); const st = $('#stage'); if (st && innerWidth < 1180) st.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    $$('.shelf[data-chave]', el).forEach(b => b.addEventListener('click', () => { M.shelf = { g: M.sel, chave: b.dataset.chave }; desenhaDetalhe(); desenhaLateral(); }));
  }

  function ligaEdicao() {
    const L = M.draft;
    if (!L.setas) L.setas = [];
    $('#eLarg').addEventListener('change', e => { L.largura = +e.target.value; desenhaPalco(); });
    $('#eAlt').addEventListener('change', e => { L.altura = +e.target.value; desenhaPalco(); });
    $$('[data-edim]').forEach(inp => inp.addEventListener('change', () => { M.draftDim[inp.dataset.edim] = +inp.value; desenhaPalco(); }));
    $('#eProp').addEventListener('click', () => {
      L.gondolas.forEach(g => {
        const { L: comp, T } = geomG(g.id);
        const len = Math.max(g.w, g.h, 60), curto = Math.round(len * T / comp * 10) / 10;
        g.rot = PE_PD(g.id) ? 90 : 0;
        g.w = g.rot === 90 ? curto : len; g.h = g.rot === 90 ? len : curto;
      });
      desenhaPalco(); toast('Proporção real aplicada — ajuste o comprimento de cada uma se quiser', 'ok', 3500);
    });
    const op = $('#eOp'); if (op) op.addEventListener('input', e => { L.fundo_opacidade = +e.target.value; const bg = $('#canvas .bg'); if (bg) bg.style.opacity = L.fundo_opacidade; });
    const sf = $('#eSemFundo'); if (sf) sf.addEventListener('click', () => { L.fundo = null; desenhaPalco(); desenhaLateral(); });
    $('#eFundo').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { L.fundo = await reduzImagem(f); desenhaPalco(); desenhaLateral(); } catch (er) { toast(er.message, 'bad'); }
    });
    const gi = $('#eGira'); if (gi) gi.addEventListener('click', () => { const g = L.gondolas.find(x => x.id === M.sel); [g.w, g.h] = [g.h, g.w]; g.rot = g.rot ? 0 : 90; desenhaPalco(); });
    const rm = $('#eRemove'); if (rm) rm.addEventListener('click', () => { L.gondolas = L.gondolas.filter(x => x.id !== M.sel); M.sel = null; desenhaPalco(); desenhaLateral(); });
    $$('[data-add]').forEach(b => b.addEventListener('click', () => {
      const id = +b.dataset.add, { L: comp, T } = geomG(id), vert = PE_PD(id), len = 200, curto = Math.round(len * T / comp * 10) / 10;
      L.gondolas.push({ id, x: 60 + (id % 5) * 40, y: 60, w: vert ? curto : len, h: vert ? len : curto, rot: vert ? 90 : 0 }); M.sel = id; M.selSeta = null; desenhaPalco(); desenhaLateral();
    }));
    $('#eNovaSeta').addEventListener('click', () => { L.setas.push({ x: Math.round(L.largura / 2 / 5) * 5, y: Math.round(L.altura / 2 / 5) * 5, c: 100, rot: 0 }); M.selSeta = L.setas.length - 1; M.sel = null; desenhaPalco(); desenhaLateral(); });
    const gs = $('#eGiraSeta'); if (gs) gs.addEventListener('click', () => { const a = L.setas[M.selSeta]; a.rot = (a.rot + 45) % 360; desenhaPalco(); });
    const rs = $('#eRemSeta'); if (rs) rs.addEventListener('click', () => { L.setas.splice(M.selSeta, 1); M.selSeta = null; desenhaPalco(); desenhaLateral(); });
    const sc = $('#eSetaC'); if (sc) sc.addEventListener('input', e => { L.setas[M.selSeta].c = +e.target.value; desenhaPalco(); });
    $('#eCancela').addEventListener('click', () => { M.edit = false; M.draft = null; M.draftDim = null; M.sel = null; M.selSeta = null; montaTudo(); });
    $('#eSalva').addEventListener('click', async () => {
      try {
        M.data.dimensoes = await api('/api/dimensoes', { method: 'PUT', body: M.draftDim });
        M.data.layout = await api('/api/layout', { method: 'PUT', body: M.draft }); M.edit = false; M.draft = null; M.draftDim = null; M.selSeta = null; toast('Planta salva', 'ok'); montaTudo(); }
      catch (er) { toast(er.message, 'bad', 5000); }
    });
  }

  // reduz a planta enviada para caber no limite (~1 MB)
  function reduzImagem(file) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let q = 0.8, out = c.toDataURL('image/jpeg', q);
        while (out.length > 1_300_000 && q > 0.3) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        out.length > 1_400_000 ? reject(new Error('Imagem grande demais mesmo reduzida')) : resolve(out);
      };
      img.onerror = () => reject(new Error('Não consegui abrir essa imagem'));
      img.src = url;
    });
  }


  // ---------- montagem ----------
  function legenda() {
    const m = METRICAS[M.metric];
    if (M.metric === 'status') {
      return `<div class="legendbar">${(M.data.faixas || []).map(f => `<span class="pill" style="--c:${esc(f.cor)}">${esc(f.status)}</span>`).join('')}</div>`;
    }
    const [a, b, c2, d] = m.ramp.length === 4 ? m.ramp.map(r => r[1]) : [m.ramp[0][1], m.ramp[0][1], m.ramp[1][1], m.ramp[1][1]];
    return `<div class="legendbar"><span>${m.leg[0]}</span><span class="ramp" style="--r0:${a};--r1:${b};--r2:${c2};--r3:${d}"></span><span>${m.leg[1]}</span></div>`;
  }

  function montaTudo() {
    const v = M.view, L = M.data.layout;
    v.innerHTML = `
      <div class="editbar reveal" style="margin-bottom:16px;justify-content:space-between">
        <div class="seg" role="group" aria-label="O que mostrar no mapa">${Object.entries(METRICAS).map(([k, m]) => `<button data-metric="${k}" aria-pressed="${M.metric === k}" title="${esc(m.desc)}">${m.nome}</button>`).join('')}</div>
        <div class="editbar">${legenda()}${!M.edit && !M.editG ? `<div class="seg" role="group" aria-label="Visualização"><button data-vista="grade" aria-pressed="${M.vista === 'grade'}">Grade</button><button data-vista="planta" aria-pressed="${M.vista === 'planta'}">Planta</button></div>` : ''}${M.ctx.admin && !M.edit && !M.editG ? `<button id="editar">${ico('edit')} Editar planta</button><button id="editarG">${ico('edit')} Editar gôndolas</button>` : ''}</div>
      </div>
      ${L.provisorio && !M.edit ? `<div class="callout reveal" style="--i:1;margin-bottom:16px">${ico('info')}<div><b>Planta provisória.</b> As gôndolas estão em grade só para você já enxergar os dados. ${M.ctx.admin ? 'Clique em <b>Editar planta</b> para arrastar cada gôndola até a posição real, aplicar a proporção real, desenhar as setas de fluxo e enviar a imagem do layout da loja como fundo.' : 'Peça a um administrador para montar a planta real.'}</div></div>` : ''}
      <div id="orfas" style="margin-bottom:16px"></div>
      <div class="mapa-wrap"><div class="stage reveal" style="--i:2" id="stage"></div><div id="lateral"></div></div>
      <div id="detalhe" style="margin-top:18px" hidden></div>
      <div class="tip" id="tip"></div>`;
    $$('[data-metric]', v).forEach(b => b.addEventListener('click', () => { M.metric = b.dataset.metric; lsSet('mapaMetrica', M.metric); montaTudo(); }));
    $$('[data-vista]', v).forEach(b => b.addEventListener('click', () => { M.vista = b.dataset.vista; lsSet('mapaVista', M.vista); montaTudo(); }));
    const ed = $('#editar', v);
    const edg = $('#editarG', v);
    if (edg) edg.addEventListener('click', () => { M.editG = true; M.novasG = null; M.removidasG = null; M.draftG = JSON.parse(JSON.stringify(M.data.gondolas_cfg || {})); M.sel = null; M.shelf = null; montaTudo(); });
    if (ed) ed.addEventListener('click', () => { M.edit = true; M.draftDim = { ...dim() }; M.draft = JSON.parse(JSON.stringify(M.data.layout)); M.draft.setas = M.draft.setas || []; M.sel = null; M.selSeta = null; M.shelf = null; montaTudo(); });
    desenhaPalco(); desenhaDetalhe(); desenhaLateral();
    if (M.ro) M.ro.disconnect();
    M.ro = new ResizeObserver(() => { const st = $('#stage'); if (!st || !st.clientWidth || st.classList.contains('stage-bare')) return; const L2 = layoutAtual(), k = escala(st.clientWidth, L2), c = $('#canvas'); if (c) { c.style.transform = `scale(${k})`; st.style.height = L2.altura * k + 'px'; st.style.overflowX = k * L2.largura > st.clientWidth + 1 ? 'auto' : 'hidden'; } });
    M.ro.observe($('#stage'));
  }

  async function render(view, ctx) {
    M.view = view; M.ctx = ctx; M.metric = lsGet('mapaMetrica', 'risco'); M.vista = lsGet('mapaVista', innerWidth < 760 ? 'grade' : 'planta'); M.edit = false; M.draft = null; M.selSeta = null; M.editG = false; M.draftG = null; M.draftDim = null;
    view.innerHTML = `<div class="skeleton" style="height:480px;border-radius:18px"></div>`;
    const [data, cfg] = await Promise.all([api('/api/mapa'), api('/api/config')]);
    data.faixas = cfg.faixas; setAreas(data.areas);
    M.data = data;
    if (M.sel !== null && !data.gondolas.some(g => g.id === M.sel)) M.sel = null;
    montaTudo();
    return data;
  }

  function selecionar(id) { M.sel = id; }
  return { render, selecionar };
})();
