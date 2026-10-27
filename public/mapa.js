'use strict';
// Mapa de calor da loja: planta (gôndolas) + detalhe por lado e prateleira. A planta é editável (arrastar/redimensionar) por administradores.
const Mapa = (() => {
  const M = { vista: 'planta', data: null, metric: 'risco', sel: null, shelf: null, selCam: null, selPt: null, lado: 'B', selPal: null, selPerim: false, guias: [], desenhando: null, draftL: null, escHandler: null, cam: null, kfit: 1, detKey: '', camAlvo: null, suprime: false, painelMin: false, edit: false, editG: false, draftG: null, draftDim: null, draft: null, view: null, ctx: null, ro: null,
    multi: [], hist: null, clip: null, espaco: false, gesto: false, multiToque: false, previa: null, org: { modo: null, escopo: 'sel', tol: 0.8, colunas: 0, entrada: false, lado: 'baixo', entradaM: 3, corredorM: 0.8, msg: '', ok: false } };

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
  const emEdicao = () => M.edit || M.editG;
  const dim = () => (emEdicao() && M.draftDim) || M.data.dimensoes || DIM0;
  const cfgTodas = () => (emEdicao() && M.draftG) || M.data.gondolas_cfg || {};
  const cfgG = id => cfgTodas()[id] || {};
  const dimG = id => ({ ...dim(), ...(cfgG(id).dim || {}) });
  const ladosG = id => (cfgG(id).lados === 'A' ? ['A'] : cfgG(id).lados === 'B' ? ['B'] : ['B', 'A']);    // de cima para baixo
  const nMod = id => cfgG(id).modulos || 5;
  const frenteNaEsquerda = id => ['F', 'PE'].includes(pontasDe(id).esq);
  const colunaDoModulo = (id, n) => (frenteNaEsquerda(id) ? n - 1 : nMod(id) - n);     // posição (0 = esquerda) do módulo n
  // medidas em cm (fonte única do tamanho): módulos × comprimento + pontas, profundidade pelos lados; sacaria usa c e l da área
  const geomG = id => Geom.geometria({ area: SACARIA(id), cfg: cfgG(id), padrao: dim() });
  const setor = (g, lado) => ((M.data.setores || {})[g] || {})[lado] || { nome: '', resp: [] };
  const bonito = n => n.charAt(0) + n.slice(1).toLowerCase();
  const respTxt = s => s.resp.map(bonito).join(', ');
  // todos os responsáveis de uma gôndola (união dos lados), para os cartões pequenos
  const respGondola = id => [...new Set(Object.values((M.data.setores || {})[id] || {}).flatMap(s => s.resp))].map(bonito).join(', ');

  // Caixa da gôndola no mapa: o tamanho é DERIVADO das medidas em cm × escala do layout (px por cm); g.w/g.h guardados no layout são só compatibilidade.
  const escalaPx = () => (layoutAtual().escala) || 0.2;
  function caixa(g) {
    const t = Geom.tamanhoCaixa(geomG(g.id), g.rot, escalaPx());
    return { x: g.x, y: g.y, w: t.w, h: t.h, aw: t.aw, ah: t.ah };
  }
  const celulaPonta = (d, lado) => (d ? d.celulas.find(c => c.chave === lado) || d.celulas.find(c => c.lado === lado && c.tipo !== 'face') || null : null);

  // desenha os retângulos (em cm) de uma gôndola; `texto` liga números e rótulos (visão detalhada)
  function formas(id, d, { texto, ox = 0, oy = 0 }) {
    const gm = geomG(id);
    const cel = (chave, x, y, w, h, rotulo, nome, ponta, extra = '') => {
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
      return `<g${extra} class="mp-cel${c ? '' : ' vazia'}${sel ? ' sel' : ''}"${chave && c ? ` data-chave="${esc(chave)}" tabindex="0" role="button" aria-label="${esc(enderecoDe(id, chave))}"` : ''}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${estilo}/>${t}</g>`;
    };
    if (gm.area) {   // sacaria: área livre; pallets cadastrados viram módulos
      const cf = cfgG(id), geral = d ? d.celulas.find(z => z.chave === 'geral') : null, kg = calor(geral, true);
      let s = `<g class="mp-cel${geral ? '' : ' vazia'}${M.shelf && M.shelf.g === id && M.shelf.chave === 'geral' ? ' sel' : ''}"${geral ? ' data-chave="geral" tabindex="0" role="button"' : ''}><rect x="${ox}" y="${oy}" width="${gm.L}" height="${gm.T}" rx="6" ${geral && !kg.vazio ? `style="fill:${kg.bg}"` : ''}/>${texto ? `<text x="${ox + 10}" y="${oy + 20}" font-size="13" font-weight="700" fill="var(--faint)">Sacaria${geral ? ' · sem pallet definido: ' + geral.lotes + ' lotes' : ''}</text>` : ''}</g>`;
      for (const p of cf.pallets || []) s += cel(`P${p.id}`, ox + p.x, oy + p.y, p.c, p.l, `P${p.id}`, p.nome, false, ` data-pal="${p.id}"`);
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

  // desenho da gôndola dentro da planta (gira 90° nas verticais); de perto (texto) ganha nomes e responsáveis de cada lado
  function svgPlanta(g, d, texto) {
    const gm = geomG(g.id), { L, T } = gm, vert = g.rot === 90;
    let rot = '';
    if (texto && !vert) {
      const p = pontasDe(g.id), lados = gm.area ? [] : ladosG(g.id);
      const tx = (lado, x, y, anchor, tam) => {
        const s = setor(g.id, lado);
        return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${tam}" font-weight="700" fill="var(--ink)">${esc(NOME_LADO[lado])}${s.nome ? ' · ' + esc(s.nome) : ''}</text>` +
          (s.resp.length ? `<text x="${x}" y="${y + tam + 3}" text-anchor="${anchor}" font-size="${tam - 2.5}" fill="var(--muted)">${esc(respTxt(s))}</text>` : '');
      };
      rot = gm.area ? tx('P', L / 2, -22, 'middle', 15)
        : (lados.includes('B') ? tx('B', L / 2, -38, 'middle', 15) : '') + (lados.includes('A') ? tx('A', L / 2, T + 24, 'middle', 15) : '') + tx(p.esq, 0, T + 24, 'start', 13) + tx(p.dir, L, T + 24, 'end', 13);
    }
    return `<svg viewBox="0 0 ${vert ? T : L} ${vert ? L : T}" width="100%" height="100%" aria-hidden="${texto ? 'false' : 'true'}">${vert ? `<g transform="translate(${T} 0) rotate(90)">` : '<g>'}${formas(g.id, d, { texto })}</g>${rot}</svg>`;
  }

  // ---------- planta ----------

  function desenhaGrade(stage) {
    const ids = [...new Set([...M.data.layout.gondolas.map(g => g.id), ...M.data.gondolas.map(g => g.id)])].sort((a, b) => a - b);
    const porId = new Map(M.data.gondolas.map(g => [g.id, g]));
    stage.innerHTML = '<div class="gridview">' + ids.map((id, i) => {
      const d = porId.get(id), h = calor(d, false), r = respGondola(id);
      return '<button class="gt' + (h.vazio ? ' vazia' : '') + (M.sel === id ? ' sel' : '') + '" data-g="' + id + '" style="--i:' + i + ';' + (h.vazio ? '' : '--hc:' + h.bg + ';--hi:' + h.ink) + '" aria-label="Gôndola ' + id + '">' +
        '<span class="n">' + id + '</span>' + (cfgTodas()[id] && cfgTodas()[id].nome ? '<span class="s">' + esc(cfgTodas()[id].nome) + '</span>' : '') + '<span class="t">' + (h.vazio ? 'vazia' : esc(h.txt)) + '</span>' + (d && !h.vazio ? '<span class="s">' + d.lotes + ' lotes</span>' : '') + (r ? '<span class="r">' + esc(r) + '</span>' : '') + (d && d.vencidos ? '<span class="tag">' + d.vencidos + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    $$('.gt', stage).forEach(b => b.addEventListener('click', () => escolheGondola(+b.dataset.g)));
    const aviso = $('#orfas'); if (aviso) aviso.innerHTML = '';
  }

  function layoutAtual() { return M.editG ? M.draftL : M.edit ? M.draft : M.data.layout; }

  const setaSvg = s => `<svg viewBox="0 0 ${s.c} 24" width="${s.c}" height="24" aria-hidden="true"><line x1="2" y1="12" x2="${s.c - 12}" y2="12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 9"/><path d="M${s.c - 16} 3 L${s.c - 2} 12 L${s.c - 16} 21 Z" fill="currentColor"/></svg>`;

  // ---------- palco com zoom e arrasto (como num CAD) ----------
  // A planta é um "mundo" em unidades do layout; a câmera (M.cam) é k (escala), tx e ty (deslocamento em pixels de tela).
  // Longe, as gôndolas aparecem como faixas de calor com número e nome; perto, mostram módulos, números, status e responsáveis.
  const DETALHE_PX = 560;                       // largura na tela a partir da qual a gôndola mostra o desenho completo
  const larguraNaTela = (g, k) => caixa(g).w * k;

  const layoutExibido = () => layoutAtual();

  function aplicaCam(anima) {
    const c = $('#canvas'); if (!c) return;
    c.style.transition = anima ? 'transform .55s var(--ease)' : 'none';
    c.style.transform = `translate(${M.cam.tx}px, ${M.cam.ty}px) scale(${M.cam.k})`;
    c.style.setProperty('--inv', String(Math.min(1.6, 1 / M.cam.k)));       // rótulos e selos mantêm o tamanho na tela
    $('#stage').classList.toggle('zoom-longe', M.cam.k < (M.kfit || 1) * 1.6);
    const fx = $('#fluxo');
    if (fx) { fx.classList.toggle('anim', !!anima); desenhaFluxo(); if (anima) setTimeout(() => { fx.classList.remove('anim'); desenhaFluxo(); }, 600); }
    desenhaAlcas(); desenhaGuias();
  }

  // enquadra a planta inteira
  function enquadra(anima) {
    const st = $('#stage'), L = layoutExibido();
    if (!st || !st.clientWidth) return;
    const w = st.clientWidth, h = st.clientHeight, k = Math.min(w / L.largura, h / L.altura) * 0.97;
    M.kfit = k;
    M.cam = { k, tx: (w - L.largura * k) / 2, ty: (h - L.altura * k) / 2, fit: true };
    aplicaCam(anima);
  }

  function zoomEm(px, py, fator) {
    const k0 = M.cam.k, k = Math.max(M.kfit * 0.7, Math.min(M.kfit * 40, k0 * fator)), r = k / k0;
    M.cam = { k, tx: px - (px - M.cam.tx) * r, ty: py - (py - M.cam.ty) * r, fit: false };
    aplicaCam(false); agendaDetalhe();
  }

  // quando a gôndola passa do limite de tamanho, redesenha com/sem os textos
  let detTimer = null;
  const chaveDetalhe = k => layoutExibido().gondolas.map(g => (larguraNaTela(g, k) >= DETALHE_PX ? 1 : 0)).join('');
  function agendaDetalhe() {
    cancelAnimationFrame(detTimer);
    detTimer = requestAnimationFrame(() => { if (chaveDetalhe(M.cam.k) !== M.detKey) desenhaPalco(); });
  }

  // aproxima a câmera de uma gôndola (vista de cima), deixando livre a área do painel
  function focaGondola(id) {
    const st = $('#stage'), g = layoutExibido().gondolas.find(x => x.id === id);
    if (M.vista === 'grade') return desenhaPalco();
    if (!st || !g) return;
    const c = caixa(g), w = st.clientWidth, h = st.clientHeight, painel = innerWidth >= 900 ? 392 : 0, aw = w - painel, ah = innerWidth >= 900 ? h : h * 0.42;
    const vert = g.rot === 90, alvoPx = vert ? Math.max(ah * 0.85, 620) / c.h : Math.max(aw * 0.9, 620) / c.w;   // o desenho completo precisa de uns 620 px de comprimento
    const k = Math.max(M.kfit, Math.min(M.kfit * 40, alvoPx));
    const alvo = { k, tx: aw / 2 - (c.x + c.w / 2) * k, ty: ah / 2 - (c.y + c.h / 2) * k, fit: false };
    M.camAlvo = alvo;                        // o desenho já nasce com o nível de detalhe do destino
    desenhaPalco();
    let feito = false;
    const ir = () => { if (feito) return; feito = true; M.cam = alvo; M.camAlvo = null; aplicaCam(true); };
    requestAnimationFrame(() => requestAnimationFrame(ir)); setTimeout(ir, 250);      // plano B se o navegador pausar as animações
  }

  function ligaCamera(st) {
    const ptrs = new Map(); let pan = null, pinca = null, moveu = false, banda = null;
    st.addEventListener('pointerdown', e => { if (!M.desenhando || !M.editG || e.target.closest('.ctrls')) return; e.stopImmediatePropagation(); e.preventDefault(); iniciaDesenho(e); }, true);
    st.addEventListener('wheel', e => {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      zoomEm(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });
    st.addEventListener('pointerdown', e => {
      if (e.target.closest('.ctrls') || e.target.closest('.alcas .alca, .alcas .alcas-corpo')) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moveu = false;
      if (e.button === 1) e.preventDefault();
      if (ptrs.size === 1) {
        // nos editores, arrastar no vazio desenha a caixa de seleção; mover o mapa é Espaço+arrastar, botão do meio ou dois dedos
        if (emEdicao() && e.button === 0 && !M.espaco && !M.desenhando) { cancelaPrevia(); banda = iniciaBanda(e, st); pan = null; }
        else pan = { x: e.clientX, y: e.clientY, tx: M.cam.tx, ty: M.cam.ty };
      }
      if (ptrs.size === 2) { if (banda) { banda.cancela(); banda = null; } const [a, b] = [...ptrs.values()]; pinca = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; pan = null; }
    });
    st.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = st.getBoundingClientRect();
      if (banda) { banda.mover(e); return; }
      if (ptrs.size === 2 && pinca) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;                       // dois dedos: o ponto médio também arrasta o mapa
        M.cam = { ...M.cam, tx: M.cam.tx + (mx - pinca.mx), ty: M.cam.ty + (my - pinca.my), fit: false };
        zoomEm(mx - r.left, my - r.top, d / pinca.d); pinca.d = d; pinca.mx = mx; pinca.my = my; moveu = true; if (!st.classList.contains('pan')) st.classList.add('pan'); return;
      }
      if (pan && ptrs.size === 1) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (!moveu && Math.hypot(dx, dy) < 5) return;
        if (!moveu) { moveu = true; st.classList.add('pan'); try { st.setPointerCapture(e.pointerId); } catch { /* ok */ } }
        M.cam = { ...M.cam, tx: pan.tx + dx, ty: pan.ty + dy, fit: false }; aplicaCam(false);
      }
    });
    const solta = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinca = null;
      if (banda && ptrs.size === 0) { const b = banda; banda = null; if (e.type === 'pointercancel') b.cancela(); else b.fim(e); }
      if (ptrs.size === 0) { pan = null; st.classList.remove('pan'); if (moveu) { M.suprime = true; setTimeout(() => { M.suprime = false; }, 0); agendaDetalhe(); moveu = false; } }
    };
    // Se o dedo sai do mapa antes de levantar, o 'pointerup' não chega ao palco e o ponteiro fica preso: aí só o zoom funcionava e o arrasto parava.
    // Por isso o fim do toque também é ouvido na janela, e quando não há mais dedos na tela tudo é zerado.
    const zera = () => { ptrs.clear(); pan = null; pinca = null; if (banda) { banda.cancela(); banda = null; } st.classList.remove('pan'); };
    const fimTouch = ev => { if (!ev.touches || !ev.touches.length) zera(); };
    if (M.limpaCam) M.limpaCam();
    window.addEventListener('pointerup', solta); window.addEventListener('pointercancel', solta);
    window.addEventListener('touchend', fimTouch, { passive: true }); window.addEventListener('touchcancel', fimTouch, { passive: true });
    M.limpaCam = () => { window.removeEventListener('pointerup', solta); window.removeEventListener('pointercancel', solta); window.removeEventListener('touchend', fimTouch); window.removeEventListener('touchcancel', fimTouch); };
    // clique no fundo vazio fecha a seleção
    st.addEventListener('click', e => { if (M.suprime || M.edit || M.editG) return; if (M.vista !== 'grade' && !e.target.closest('.gon') && !e.target.closest('.ctrls') && M.sel !== null) { M.sel = null; M.shelf = null; desenhaPalco(); desenhaLateral(); } });
    $('#cMais').addEventListener('click', () => zoomEm(st.clientWidth / 2, st.clientHeight / 2, 1.6));
    $('#cMenos').addEventListener('click', () => zoomEm(st.clientWidth / 2, st.clientHeight / 2, 1 / 1.6));
    $('#cFit').addEventListener('click', () => { enquadra(true); setTimeout(agendaDetalhe, 600); });
  }

  function desenhaPalco() {
    const L = layoutExibido();
    const stage = $('#stage');
    if (!stage) return;
    const grade = M.vista === 'grade' && !M.edit && !M.editG;
    stage.classList.toggle('stage-bare', grade);
    $('#ctrls').hidden = grade;
    if (grade) { stage.style.height = 'auto'; return desenhaGrade(stage); }
    stage.style.height = '';
    const porId = new Map(M.data.gondolas.map(g => [g.id, g]));
    const noLayout = new Set(L.gondolas.map(g => g.id));
    if (!M.cam) enquadra(false);
    const kDet = (M.camAlvo || M.cam).k;
    M.detKey = chaveDetalhe(kDet);
    const entra = M.anim; M.anim = false;
    stage.innerHTML = `<div class="canvas${entra ? ' entra' : ''}" id="canvas" style="width:${L.largura}px;height:${L.altura}px">
      ${L.fundo ? `<div class="bg" style="background-image:url('${esc(L.fundo)}');opacity:${L.fundo_opacidade}"></div>` : ''}
      <div class="grid-bg"></div><div class="perimetro"></div>
      ${L.gondolas.map((g, i) => {
        const d = porId.get(g.id), c = caixa(g), texto = larguraNaTela(g, kDet) >= DETALHE_PX, nome = (cfgTodas()[g.id] || {}).nome, r = respGondola(g.id);
        const resumo = d && d.lotes ? `${d.risco ? brlK(d.risco) : 'ok'}` : '';
        return `<div class="gon${selIds().includes(g.id) ? ' sel' : ''}${emEdicao() ? ' edit' : ''}${texto ? ' perto' : ''}" data-g="${g.id}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px;--i:${i}" tabindex="0" role="button" aria-label="${esc(rotuloG(g.id))}">
          ${svgPlanta(g, d, texto)}<span class="gn"><b>${g.id}</b>${nome ? ` · ${esc(nome)}` : ''}${!texto && (resumo || r) ? `<small>${[resumo, r].filter(Boolean).map(esc).join(' · ')}</small>` : ''}</span>${d && d.vencidos ? `<span class="tag">${d.vencidos}</span>` : ''}</div>`;
      }).join('')}</div><svg id="fluxo" class="fluxo" aria-hidden="true"></svg><svg id="alcas" class="alcas" aria-hidden="true"></svg><svg id="guias" class="guias" aria-hidden="true"></svg>`;
    aplicaCam(false);
    const orfas = M.data.gondolas.filter(g => !noLayout.has(g.id));
    const aviso = $('#orfas');
    if (aviso) aviso.innerHTML = orfas.length ? `<div class="callout warn">${ico('alert')}<div>Gôndola(s) <b>${orfas.map(g => g.id).join(', ')}</b> têm estoque mas ainda não estão na planta. ${M.ctx.admin ? 'Use “Editar planta” para posicioná-las.' : ''}</div></div>` : '';
    ligaPalco();
  }

  // ---------- alças de redimensionar (nas quatro direções) e desenho de novas gôndolas ----------
  const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  const snap5 = v => Math.round(v / 5) * 5;
  const r1 = Geom.r1;
  const limita = (v, a, b) => Math.max(a, Math.min(b, v));
  const layoutEditavel = () => (M.editG ? M.draftL : M.edit ? M.draft : null);
  const escalaCm = () => escalaPx();                                              // pixels do mapa por centímetro (um só valor para a loja toda)

  // o que está selecionado para editar e o retângulo dele no mapa
  function alvoDeEdicao() {
    const Lx = layoutEditavel();
    if (Lx && M.selPerim) return { tipo: 'perim', g: null, kcm: 1, rect: { x: 0, y: 0, w: Lx.largura, h: Lx.altura }, corpo: false };
    if (Lx && M.sel === null) {                                                  // várias selecionadas: só a moldura do grupo
      const rs = selIds().map(id => Lx.gondolas.find(g => g.id === id)).filter(Boolean).map(g => caixa(g));
      if (rs.length > 1) return { tipo: 'grupo', g: null, kcm: 1, rect: Geom.caixaDe(rs), corpo: false };
    }
    if (!Lx || M.sel === null) return null;
    const g = Lx.gondolas.find(x => x.id === M.sel);
    if (!g) return null;
    const c = caixa(g), kcm = c.w / c.aw, cf = cfgTodas()[g.id] || {};
    if (M.editG && SACARIA(g.id) && M.selPal !== null) {
      const p = (cf.pallets || []).find(q => q.id === M.selPal);
      if (p) return { tipo: 'pal', g, p, kcm, rect: { x: c.x + p.x * kcm, y: c.y + p.y * kcm, w: p.c * kcm, h: p.l * kcm }, corpo: true };
    }
    return { tipo: 'gond', g, kcm, rect: { x: c.x, y: c.y, w: c.w, h: c.h }, corpo: false, vert: g.rot === 90 };   // mover é arrastar a própria gôndola (iniciaMover)
  }

  function desenhaAlcas() {
    const svg = $('#alcas');
    if (!svg || !M.cam) return;
    const al = alvoDeEdicao();
    if (!al || M.desenhando) { svg.innerHTML = ''; return; }
    const k = M.cam.k, r = al.rect, x = r.x * k + M.cam.tx, y = r.y * k + M.cam.ty, w = r.w * k, h = r.h * k, s = 11;
    // nos dois editores as alças mexem nas medidas em cm (o tamanho da caixa é derivado delas)
    const dirs = al.tipo === 'perim' ? ['e', 's', 'se'] : al.tipo === 'grupo' ? [] : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const pos = { n: [x + w / 2, y], s: [x + w / 2, y + h], e: [x + w, y + h / 2], w: [x, y + h / 2], ne: [x + w, y], nw: [x, y], se: [x + w, y + h], sw: [x, y + h] };
    svg.innerHTML = `<rect class="alcas-borda" x="${x}" y="${y}" width="${w}" height="${h}"/>` + (al.corpo ? `<rect class="alcas-corpo" x="${x}" y="${y}" width="${w}" height="${h}"/>` : '') +
      dirs.map(d => `<rect class="alca" data-d="${d}" x="${pos[d][0] - s / 2}" y="${pos[d][1] - s / 2}" width="${s}" height="${s}" rx="2" style="cursor:${CURSOR[d]}"/>`).join('');
    $$('.alca', svg).forEach(a => a.addEventListener('pointerdown', e => arrastaAlca(e, a.dataset.d)));
    const cp = $('.alcas-corpo', svg); if (cp) cp.addEventListener('pointerdown', e => arrastaAlca(e, 'mover'));
  }

  function arrastaAlca(e, dir) {
    e.stopPropagation(); e.preventDefault();
    const al = alvoDeEdicao();
    if (!al || al.tipo === 'grupo') return;
    cancelaPrevia();
    if (al.tipo === 'perim') return arrastaPerim(e, dir);
    M.gesto = true;
    const g = al.g, cfg = (M.draftG[g.id] = M.draftG[g.id] || {}), k = M.cam.k, kcm = al.kcm, x0 = e.clientX, y0 = e.clientY;
    const c0 = caixa(g), ini = { x: c0.x, y: c0.y, w: c0.w, h: c0.h }, gx = g.x, gy = g.y;
    const geo0 = geomG(g.id), cfg0 = JSON.parse(JSON.stringify(cfg)), p0 = al.p ? { ...al.p } : null;
    const D = dimG(g.id), n = nMod(g.id), nl = ladosG(g.id).length;
    const area = (cfg0 && cfg0.pallets) ? { c: cfg0.c ?? 600, l: cfg0.l ?? 400 } : null;
    let raf = 0, cz = { x: false, y: false };
    const aplica = ev => {
      let dpx = (ev.clientX - x0) / k, dpy = (ev.clientY - y0) / k;                                           // pixels do mapa
      const sx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0, sy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
      cz = { x: false, y: false };
      if (al.tipo === 'gond') {
        const Lp = layoutEditavel();
        if (dir !== 'mover') {                                                                                // a borda arrastada não sai do perímetro
          if (sx > 0) dpx = Math.min(dpx, Lp.largura - ini.x - ini.w); if (sx < 0) dpx = Math.max(dpx, -ini.x);
          if (sy > 0) dpy = Math.min(dpy, Lp.altura - ini.y - ini.h); if (sy < 0) dpy = Math.max(dpy, -ini.y);
        }
        if (!ev.altKey) {
          if (dir === 'mover') {
            const s = alinha({ x: ini.x + dpx, y: ini.y + dpy, w: ini.w, h: ini.h }, [0, 1, 2], [0, 1, 2], g.id);
            if (s.cx) { dpx += s.dx; cz.x = true; } if (s.cy) { dpy += s.dy; cz.y = true; }
          } else {
            const r = { x: ini.x + (sx < 0 ? dpx : 0), y: ini.y + (sy < 0 ? dpy : 0), w: ini.w + sx * dpx, h: ini.h + sy * dpy };
            const s = alinha(r, sx > 0 ? [2] : sx < 0 ? [0] : [], sy > 0 ? [2] : sy < 0 ? [0] : [], g.id);
            if (s.cx) dpx += s.dx; if (s.cy) dpy += s.dy;
          }
        }
      }
      const dX = dpx / kcm, dY = dpy / kcm;                                                                    // centímetros
      if (al.tipo === 'pal') {
        const p = cfg.pallets.find(q => q.id === p0.id);
        if (dir === 'mover') { p.x = limita(snap5(p0.x + dX), 0, area.c - p0.c); p.y = limita(snap5(p0.y + dY), 0, area.l - p0.l); }
        else {
          let nx = p0.x, ny = p0.y, nc = p0.c, nL = p0.l;
          if (sx > 0) nc = p0.c + dX; if (sx < 0) { nc = p0.c - dX; nx = p0.x + dX; }
          if (sy > 0) nL = p0.l + dY; if (sy < 0) { nL = p0.l - dY; ny = p0.y + dY; }
          nc = limita(snap5(nc), 20, 600); nL = limita(snap5(nL), 20, 600);
          if (sx < 0) nx = p0.x + p0.c - nc; if (sy < 0) ny = p0.y + p0.l - nL;
          p.x = limita(snap5(nx), 0, area.c - 20); p.y = limita(snap5(ny), 0, area.l - 20);
          p.c = Math.min(nc, area.c - p.x); p.l = Math.min(nL, area.l - p.y);
        }
      } else {                                                                      // redimensionar: muda as medidas em cm; a caixa é derivada delas
        let nw, nh;
        const gw = sx * dX, gh = sy * dY;                                           // crescimento em cm nos eixos da tela
        if (geo0.area) {
          cfg.c = limita(snap5((cfg0.c ?? 600) + gw), 100, 3000); cfg.l = limita(snap5((cfg0.l ?? 400) + gh), 100, 3000);
          nw = cfg.c * kcm; nh = cfg.l * kcm;
        } else {
          const vert = g.rot === 90, cresceLen = vert ? gh : gw, cresceEsp = vert ? gw : gh;
          cfg.dim = { ...(cfg0.dim || {}) };
          if (cresceLen) cfg.dim.modulo_c = limita(Math.round((geo0.L - 2 * D.ponta_p + cresceLen) / n), 40, 300);
          if (cresceEsp) cfg.dim.modulo_l = limita(Math.round((nl * D.modulo_l + cresceEsp) / nl), 20, 100);
          const gm = geomG(g.id);
          nw = (vert ? gm.T : gm.L) * kcm; nh = (vert ? gm.L : gm.T) * kcm;
        }
        g.x = r1(sx < 0 ? ini.x + ini.w - nw : ini.x); g.y = r1(sy < 0 ? ini.y + ini.h - nh : ini.y);
      }
      M.guias = al.tipo === 'gond' && !ev.altKey ? guiasDe(caixa(g), g.id) : [];
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; desenhaPalco(); });
    };
    const fim = () => { window.removeEventListener('pointermove', aplica); window.removeEventListener('pointerup', fim); cancelAnimationFrame(raf); M.guias = []; M.gesto = false; empilha(); desenhaPalco(); desenhaLateral(); };
    window.addEventListener('pointermove', aplica); window.addEventListener('pointerup', fim);
  }

  // ---------- guias de alinhamento (como no CAD e no Canva) e perímetro ----------
  // Ao mover ou redimensionar, as bordas e o centro da gôndola "grudam" nas bordas e nos centros das outras (e do perímetro) a até 7 px na tela;
  // as linhas magenta mostram com quem alinhou. Segurar Alt desliga o ímã.
  const SNAP_PX = 7;
  const alvosGuia = id => {                                          // id: uma gôndola ou a lista das que estão sendo movidas em grupo
    const Lx = layoutEditavel() || M.data.layout, fora = Array.isArray(id) ? id : [id];
    return [...Lx.gondolas.filter(g => !fora.includes(g.id)).map(caixa), { x: 0, y: 0, w: Lx.largura, h: Lx.altura }];
  };
  const linhasDe = (ini, tam) => [ini, ini + tam / 2, ini + tam];
  function alinha(r, qx, qy, id) {
    const thr = SNAP_PX / M.cam.k, alvos = alvosGuia(id);
    const eixo = (ini, tam, quais, tAx) => {
      const meus = linhasDe(ini, tam); let d = null;
      for (const i of quais) for (const a of alvos) for (const p of linhasDe(a[tAx[0]], a[tAx[1]])) { const df = p - meus[i]; if (Math.abs(df) <= thr && (d === null || Math.abs(df) < Math.abs(d))) d = df; }
      return d;
    };
    const dx = eixo(r.x, r.w, qx, ['x', 'w']), dy = eixo(r.y, r.h, qy, ['y', 'h']);
    return { dx: dx ?? 0, dy: dy ?? 0, cx: dx !== null, cy: dy !== null };
  }
  function guiasDe(r, id) {
    const alvos = alvosGuia(id), tol = 0.75, out = [];
    for (const a of alvos) {
      for (const p of linhasDe(r.x, r.w)) if (linhasDe(a.x, a.w).some(q => Math.abs(q - p) <= tol)) out.push({ x1: p, x2: p, y1: Math.min(r.y, a.y), y2: Math.max(r.y + r.h, a.y + a.h) });
      for (const p of linhasDe(r.y, r.h)) if (linhasDe(a.y, a.h).some(q => Math.abs(q - p) <= tol)) out.push({ y1: p, y2: p, x1: Math.min(r.x, a.x), x2: Math.max(r.x + r.w, a.x + a.w) });
    }
    return out;
  }
  function desenhaGuias() {
    const svg = $('#guias'); if (!svg || !M.cam) return;
    const k = M.cam.k, tx = M.cam.tx, ty = M.cam.ty;
    svg.innerHTML = (M.guias || []).map(l => `<line x1="${l.x1 * k + tx}" y1="${l.y1 * k + ty}" x2="${l.x2 * k + tx}" y2="${l.y2 * k + ty}"/>`).join('');
  }
  function arrastaPerim(e, dir) {
    e.stopPropagation(); e.preventDefault();
    const Lx = layoutEditavel(), k = M.cam.k, x0 = e.clientX, y0 = e.clientY, W0 = Lx.largura, H0 = Lx.altura;
    const minW = Math.max(400, ...Lx.gondolas.map(g => { const c = caixa(g); return c.x + c.w; })), minH = Math.max(300, ...Lx.gondolas.map(g => { const c = caixa(g); return c.y + c.h; }));
    let raf = 0; M.gesto = true; cancelaPrevia();
    const aplica = ev => {
      if (dir.includes('e')) Lx.largura = limita(Math.round((W0 + (ev.clientX - x0) / k) / 10) * 10, Math.ceil(minW / 10) * 10, 4000);
      if (dir.includes('s')) Lx.altura = limita(Math.round((H0 + (ev.clientY - y0) / k) / 10) * 10, Math.ceil(minH / 10) * 10, 4000);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; desenhaPalco(); });
    };
    const fim = () => { window.removeEventListener('pointermove', aplica); window.removeEventListener('pointerup', fim); cancelAnimationFrame(raf); M.gesto = false; empilha(); desenhaPalco(); desenhaLateral(); };
    window.addEventListener('pointermove', aplica); window.addEventListener('pointerup', fim);
  }
  const botaoPerim = () => `<button class="sm${M.selPerim ? ' primary' : ''}" id="ePerim">${ico('map')} Ajustar perímetro</button>`;
  function ligaPerim() {
    const b = $('#ePerim'); if (!b) return;
    b.addEventListener('click', () => { M.selPerim = !M.selPerim; if (M.selPerim) { M.sel = null; M.multi = []; M.selPal = null; M.selCam = null; M.selPt = null; } desenhaPalco(); desenhaLateral(); });
  }

  // ---------- seleção de várias gôndolas, desfazer/refazer, teclado e ferramentas de CAD ----------
  // M.sel = a gôndola selecionada quando é uma só (o painel mostra os dados dela); com 2 ou mais, M.sel é null e M.multi guarda a lista.
  const existe = id => { const L = layoutEditavel(); return !!L && L.gondolas.some(g => g.id === id); };
  function selIds() {
    if (M.sel !== null) return [M.sel];
    const L = layoutAtual();
    return (M.multi || []).filter(id => L.gondolas.some(g => g.id === id));
  }
  function fixaSel(ids) {
    ids = [...new Set(ids)];
    M.multi = ids; M.sel = ids.length === 1 ? ids[0] : null; M.selPerim = false;
    if (ids.length) { M.selCam = null; M.selPt = null; }
    if (ids.length !== 1) M.selPal = null;
  }
  function atualizaSel() {                                      // marca na tela sem refazer o desenho (não perde o clique em andamento)
    const s = new Set(selIds());
    $$('#canvas .gon').forEach(el => el.classList.toggle('sel', s.has(+el.dataset.g)));
    desenhaAlcas(); desenhaLateral();
  }
  function rectsDe(ids) {
    const L = layoutEditavel();
    return ids.map(id => L.gondolas.find(g => g.id === id)).filter(Boolean).map(g => { const c = caixa(g); return { id: g.id, x: g.x, y: g.y, w: c.w, h: c.h }; });
  }
  const limitePerim = () => { const L = layoutEditavel(); return { x: 0, y: 0, w: L.largura, h: L.altura }; };
  function aplicaPos(pos) {
    const L = layoutEditavel();
    for (const p of pos) { const g = L.gondolas.find(x => x.id === p.id); if (g) { g.x = p.x; g.y = p.y; } }
  }
  const fmtM = v => (Math.round(v * 100) / 100).toLocaleString('pt-BR');

  // ----- desfazer / refazer: fotos do rascunho todo (planta + configuração das gôndolas + medidas padrão), no fim de cada gesto -----
  // A imagem de fundo não entra nas fotos (pesa muito): desfazer não a troca.
  const HIST_MAX = 50;
  function foto() {
    const { fundo, ...L } = layoutEditavel();
    const G = Object.fromEntries(Object.entries(M.draftG || {}).filter(([, v]) => v && Object.keys(v).length));
    return JSON.stringify({ L, G, D: M.draftDim });
  }
  function iniciaHist() { M.hist = { p: [foto()], i: 0 }; M.previa = null; M.org.modo = null; M.org.msg = ''; M.org.ok = false; M.clip = M.clip || null; }
  function empilha() {
    if (!M.hist || !emEdicao() || M.previa) return;
    const s = foto(), h = M.hist;
    if (s === h.p[h.i]) return;
    h.p.length = h.i + 1; h.p.push(s);
    if (h.p.length > HIST_MAX) h.p.shift();
    h.i = h.p.length - 1;
    atualizaBotoesHist();
  }
  function atualizaBotoesHist() {
    const h = M.hist, d = !h || h.i <= 0, r = !h || h.i >= h.p.length - 1;
    [['#hDesf', d], ['#cDesf', d], ['#hRef', r], ['#cRef', r]].forEach(([q, v]) => { const b = $(q); if (b) b.disabled = v; });
  }
  function restaura(s) {
    const o = JSON.parse(s), fundo = layoutEditavel().fundo, nova = { ...o.L, fundo };
    if (M.editG) M.draftL = nova; else M.draft = nova;
    M.draftG = o.G; M.draftDim = o.D;
    fixaSel(selIds().filter(id => nova.gondolas.some(g => g.id === id)));
    if (M.selCam !== null && !(nova.caminhos || [])[M.selCam]) { M.selCam = null; M.selPt = null; }
    M.selPal = null; M.guias = [];
    desenhaPalco(); desenhaLateral();
  }
  function desfaz() {
    cancelaPrevia(); empilha();
    const h = M.hist; if (!h || h.i <= 0) return;
    h.i--; restaura(h.p[h.i]);
  }
  function refaz() {
    cancelaPrevia();
    const h = M.hist; if (!h || h.i >= h.p.length - 1) return;
    h.i++; restaura(h.p[h.i]);
  }

  // ----- arrastar gôndolas (uma ou o grupo selecionado) -----
  function iniciaMover(e, id) {
    if (e.button !== 0 || M.espaco || M.desenhando) return;       // botão do meio e Espaço deixam o mapa arrastar
    e.stopPropagation();
    cancelaPrevia();
    const Lx = layoutEditavel(), antes = selIds(), alterna = e.shiftKey || M.multiToque;
    if (alterna) {
      const nova = antes.includes(id) ? antes.filter(x => x !== id) : [...antes, id];
      fixaSel(nova); atualizaSel();
      if (!nova.includes(id)) return;
    } else if (!antes.includes(id)) { fixaSel([id]); atualizaSel(); }
    const ids = selIds().filter(existe), gs = ids.map(i => Lx.gondolas.find(g => g.id === i));
    const ini = gs.map(g => ({ g, x: g.x, y: g.y })), rs = rectsDe(ids), b0 = Geom.caixaDe(rs), lim = limitePerim();
    const colapsa = !alterna && antes.length > 1 && antes.includes(id);       // clique sem arrastar num item do grupo seleciona só ele
    const x0 = e.clientX, y0 = e.clientY, k = M.cam.k;
    let moveu = false;
    const mover = ev => {
      if (!moveu && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!moveu) { moveu = true; M.gesto = true; }
      let dx = (ev.clientX - x0) / k, dy = (ev.clientY - y0) / k, cz = { x: false, y: false };
      if (!ev.altKey) {                                                       // o grupo todo gruda nas guias, como uma peça só
        const s = alinha({ x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h }, [0, 1, 2], [0, 1, 2], ids);
        if (s.cx) { dx += s.dx; cz.x = true; } if (s.cy) { dy += s.dy; cz.y = true; }
      }
      if (!cz.x) dx = snap5(b0.x + dx) - b0.x;
      if (!cz.y) dy = snap5(b0.y + dy) - b0.y;
      const d = Geom.limitaGrupo(rs, dx, dy, lim);
      for (const o of ini) {
        o.g.x = r1(o.x + d.dx); o.g.y = r1(o.y + d.dy);
        const el = $(`#canvas .gon[data-g="${o.g.id}"]`);
        if (el) { el.style.left = o.g.x + 'px'; el.style.top = o.g.y + 'px'; }
      }
      M.guias = ev.altKey ? [] : guiasDe({ x: b0.x + d.dx, y: b0.y + d.dy, w: b0.w, h: b0.h }, ids);
      desenhaGuias(); desenhaAlcas();
    };
    const fim = () => {
      window.removeEventListener('pointermove', mover); window.removeEventListener('pointerup', fim); window.removeEventListener('pointercancel', fim);
      M.guias = []; M.gesto = false;
      if (moveu) { M.suprime = true; setTimeout(() => { M.suprime = false; }, 0); empilha(); desenhaPalco(); desenhaLateral(); }
      else if (colapsa) { fixaSel([id]); atualizaSel(); }
    };
    window.addEventListener('pointermove', mover); window.addEventListener('pointerup', fim); window.addEventListener('pointercancel', fim);
    e.preventDefault();
  }

  // ----- caixa de seleção no vazio (toque com um dedo; Shift soma à seleção) -----
  function iniciaBanda(e, st) {
    const r0 = st.getBoundingClientRect(), soma = e.shiftKey || M.multiToque, base = soma ? selIds() : [];
    const mundo = ev => ({ x: (ev.clientX - r0.left - M.cam.tx) / M.cam.k, y: (ev.clientY - r0.top - M.cam.ty) / M.cam.k });
    const a = mundo(e), ret = ev => { const b = mundo(ev); return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; };
    let ativa = false, rasc = null;
    try { st.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ }
    return {
      mover(ev) {
        if (!ativa && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        if (!ativa) { ativa = true; rasc = document.createElement('div'); rasc.className = 'rasc'; st.appendChild(rasc); }
        const r = ret(ev);
        Object.assign(rasc.style, { left: r.x * M.cam.k + M.cam.tx + 'px', top: r.y * M.cam.k + M.cam.ty + 'px', width: r.w * M.cam.k + 'px', height: r.h * M.cam.k + 'px' });
      },
      cancela() { if (rasc) rasc.remove(); },
      fim(ev) {
        if (rasc) rasc.remove();
        if (!ativa) { if (soma) return; fixaSel([]); M.selCam = null; M.selPt = null; desenhaPalco(); desenhaLateral(); return; }   // toque no vazio solta a seleção
        const r = ret(ev), dentro = layoutEditavel().gondolas.filter(g => { const c = caixa(g); return c.x < r.x + r.w && r.x < c.x + c.w && c.y < r.y + r.h && r.y < c.y + c.h; }).map(g => g.id);
        fixaSel([...base, ...dentro]); M.selCam = null; M.selPt = null;
        M.suprime = true; setTimeout(() => { M.suprime = false; }, 0);
        desenhaPalco(); desenhaLateral();
      },
    };
  }

  // ----- operações sobre a seleção -----
  function selecionaTudo() {
    cancelaPrevia();
    fixaSel(layoutEditavel().gondolas.map(g => g.id)); M.selCam = null; M.selPt = null;
    desenhaPalco(); desenhaLateral();
  }
  function capturaSel() {
    const ids = selIds().filter(existe), L = layoutEditavel();
    if (!ids.length) return null;
    return { n: 0, itens: ids.map(id => {
      const g = L.gondolas.find(x => x.id === id), cf = cfgTodas()[id] || {}, area = SACARIA(id);
      // cópia da configuração (lados, módulos, medidas, nomes dos módulos, pallets). Os responsáveis pelos lados ficam de fora.
      return { x: g.x, y: g.y, rot: g.rot, cfg: Geom.copiaCfg({ ...cf, tipo: area ? 'area' : 'gondola', ...(area ? { c: cf.c || 600, l: cf.l || 400 } : {}) }) };
    }) };
  }
  function colaClip(clip, passo) {
    cancelaPrevia();
    if (!clip || !clip.itens.length) { toast('Nada copiado ainda', 'bad', 2000); return; }
    const L = layoutEditavel(), off = 20 * passo;
    const ocupados = new Set([...L.gondolas.map(g => g.id), ...Object.keys(M.draftG).map(Number), ...M.data.gondolas.map(g => g.id)]);
    const novos = [];
    for (const it of clip.itens) {
      const id = Geom.proximoLivre(ocupados, 40);
      if (id === null) { toast('Não há número livre (1 a 40)', 'bad'); break; }
      ocupados.add(id);
      M.draftG[id] = JSON.parse(JSON.stringify(it.cfg));
      const g = { id, x: it.x + off, y: it.y + off, w: 0, h: 0, rot: it.rot };
      L.gondolas.push(g); novos.push(g);
    }
    if (!novos.length) return;
    const d = Geom.limitaGrupo(novos.map(g => ({ id: g.id, ...caixa(g) })), 0, 0, limitePerim());      // a cópia fica dentro do perímetro
    novos.forEach(g => { g.x = r1(g.x + d.dx); g.y = r1(g.y + d.dy); const c = caixa(g); g.w = r1(c.w); g.h = r1(c.h); });
    fixaSel(novos.map(g => g.id)); empilha(); desenhaPalco(); desenhaLateral();
    toast(novos.length > 1 ? `${novos.length} gôndolas criadas: ${novos.map(g => g.id).join(', ')}` : `Gôndola ${novos[0].id} criada`, 'ok', 2500);
  }
  function excluiSel() {
    cancelaPrevia();
    const ids = selIds().filter(existe); if (!ids.length) return;
    const L = layoutEditavel(), salvas = M.data.gondolas_cfg || {};
    for (const id of ids) if ((M.editG && id >= 19) || !salvas[id]) delete M.draftG[id];     // a configuração só some se foi criada agora ou (em Editar gôndolas) é 19 em diante
    L.gondolas = L.gondolas.filter(g => !ids.includes(g.id));
    fixaSel([]); empilha(); desenhaPalco(); desenhaLateral();
    toast(ids.length > 1 ? `${ids.length} gôndolas tiradas da planta` : `Gôndola ${ids[0]} tirada da planta`, 'ok', 2000);
  }
  function giraSel() {
    cancelaPrevia();
    const L = layoutEditavel();
    for (const id of selIds().filter(existe)) {
      const g = L.gondolas.find(x => x.id === id); g.rot = g.rot ? 0 : 90;
      const c = caixa(g), d = Geom.limitaGrupo([{ id, ...c }], 0, 0, limitePerim()); g.x = r1(g.x + d.dx); g.y = r1(g.y + d.dy);
    }
    empilha(); desenhaPalco(); desenhaLateral();
  }
  function nudge(dx, dy) {
    const ids = selIds().filter(existe); if (!ids.length) return;
    const d = Geom.limitaGrupo(rectsDe(ids), dx, dy, limitePerim()), L = layoutEditavel();
    for (const id of ids) { const g = L.gondolas.find(x => x.id === id); g.x = r1(g.x + d.dx); g.y = r1(g.y + d.dy); }
    desenhaPalco(); clearTimeout(M.nudgeT); M.nudgeT = setTimeout(empilha, 400);
  }
  function opAlinhar(modo) {
    cancelaPrevia();
    const rs = rectsDe(selIds().filter(existe)); if (rs.length < 2) return;
    aplicaPos(Geom.alinhar(rs, modo)); empilha(); desenhaPalco(); desenhaLateral();
  }
  function opDistribuir(eixo) {
    cancelaPrevia();
    const rs = rectsDe(selIds().filter(existe)), r = Geom.distribuir(rs, eixo);
    if (!r.ok) { toast(r.motivo, 'bad', 3000); return; }
    aplicaPos(r.pos); empilha(); desenhaPalco(); desenhaLateral();
  }

  // ----- Organizar: calcula um arranjo, mostra na planta como prévia; Aplicar confirma (desfazível) e Cancelar volta -----
  const orgPx = m => Geom.mParaPx(m, escalaPx());
  function revertePosicoes() {
    if (!M.previa) return;
    aplicaPos(M.previa.antes);
  }
  function cancelaPrevia(redesenha = true) {
    if (!M.previa) return;
    revertePosicoes(); M.previa = null; M.org.modo = null; M.org.msg = ''; M.org.ok = false;
    if (redesenha) { desenhaPalco(); desenhaLateral(); }
  }
  function calculaPrevia() {
    const o = M.org; if (!o.modo) return;
    const L = layoutEditavel();
    revertePosicoes();                                                                // recalcula sempre a partir das posições originais
    const todos = rectsDe(L.gondolas.map(g => g.id));
    if (!M.previa) M.previa = { antes: todos.map(r => ({ id: r.id, x: r.x, y: r.y })) };
    const sel = selIds().filter(existe), usaSel = o.escopo === 'sel' && sel.length >= 2, rs = usaSel ? todos.filter(r => sel.includes(r.id)) : todos;
    const lim = limitePerim(), tol = orgPx(o.tol), corr = orgPx(o.corredorM), colunas = Math.max(0, Math.round(+o.colunas) || 0);
    let plano;
    if (rs.length < 2) plano = { ok: false, motivo: 'Há menos de 2 gôndolas na planta para organizar' };
    else if (o.modo === 'alinhar') plano = Geom.planoAlinhar(rs, { tol });
    else if (o.modo === 'espaco') plano = Geom.planoEspacamento(rs, { tol, gapMin: 0 });
    else {
      const livre = Geom.areaLivre(lim, o.entrada ? { lado: o.lado, tam: orgPx(o.entradaM) } : null);
      let area = livre;
      if (usaSel) {                                       // com seleção, a grade ocupa o retângulo que a seleção já ocupa (sem invadir a faixa da entrada)
        const b = Geom.caixaDe(rs), x0 = Math.max(b.x, livre.x), y0 = Math.max(b.y, livre.y), x1 = Math.min(b.x + b.w, livre.x + livre.w), y1 = Math.min(b.y + b.h, livre.y + livre.h);
        area = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
      }
      plano = area ? Geom.planoGrade(rs, { area, bordas: !usaSel, colunas, gapMin: corr, gapMax: orgPx(4) }) : { ok: false, motivo: 'A seleção está dentro da faixa reservada para a entrada' };
      if (!plano.ok && plano.falta !== undefined) plano.motivo = `Não cabe${colunas > 0 ? ` com ${plano.colunas} coluna${plano.colunas > 1 ? 's' : ''}` : ''}: faltam cerca de ${fmtM(Geom.pxParaM(plano.falta, escalaPx()))} m para manter corredores de ${fmtM(o.corredorM)} m. Tente outro número de colunas, um corredor menor ou um perímetro maior.`;
    }
    if (plano.ok) { const v = Geom.valida(todos, plano.pos, lim); if (!v.ok) plano = { ok: false, motivo: `Não cabe sem sobrepor: ${v.motivo.charAt(0).toLowerCase()}${v.motivo.slice(1)}.` }; }
    if (plano.ok) aplicaPos(plano.pos);
    const mm = px => fmtM(Geom.pxParaM(px, escalaPx()));
    o.ok = plano.ok;
    o.msg = plano.ok ? (o.modo === 'alinhar' ? 'Linhas e colunas alinhadas, na mesma ordem.' : o.modo === 'espaco' ? `Corredores iguais: ${mm(plano.gapH)} m entre gôndolas e ${mm(plano.gapV)} m entre linhas.` : `Grade de ${plano.colunas} coluna${plano.colunas > 1 ? 's' : ''} × ${plano.linhas} linha${plano.linhas > 1 ? 's' : ''}, corredores de ${mm(plano.gapH)} m e ${mm(plano.gapV)} m.`) : plano.motivo;
    desenhaPalco(); atualizaOrgUI();
  }
  function atualizaOrgUI() {
    const o = M.org, m = $('#orgMsg'), a = $('#orgAplica');
    if (m) { m.hidden = !o.msg; m.className = 'callout ' + (o.ok ? 'ok' : 'warn'); m.innerHTML = esc(o.msg); }
    if (a) a.disabled = !(M.previa && o.ok);
    $$('#orgModo button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === o.modo)));
    $$('[data-so]').forEach(el => { el.hidden = !o.modo || !el.dataset.so.split(' ').includes(o.modo); });
  }
  function aplicaPrevia() {
    if (!M.previa || !M.org.ok) return;
    M.previa = null; M.org.modo = null; M.org.msg = ''; M.org.ok = false;
    empilha(); desenhaPalco(); desenhaLateral();
    toast('Arranjo aplicado — Ctrl+Z desfaz', 'ok', 2500);
  }

  // ----- painel: desfazer, seleção, copiar/colar, alinhar, distribuir, organizar -----
  function blocoSelecao() {
    const ids = selIds().filter(existe), n = ids.length, h = M.hist, o = M.org;
    const dis = c => (c ? '' : ' disabled'), pode = !!h && h.i > 0, podeR = !!h && h.i < h.p.length - 1;
    const tam = n === 1 ? ` · ${fmtM(geomG(ids[0]).L / 100)} × ${fmtM(geomG(ids[0]).T / 100)} m` : '';
    const al = (m, t) => `<button class="sm" data-al="${m}"${dis(n >= 2)}>${t}</button>`;
    const campo = (so, html) => `<div data-so="${so}"${o.modo && so.split(' ').includes(o.modo) ? '' : ' hidden'}>${html}</div>`;
    return `<div class="selbloco">
      <div class="editbar"><button class="sm" id="hDesf"${dis(pode)}>${ico('undo')} Desfazer</button><button class="sm" id="hRef"${dis(podeR)}><span class="flip">${ico('undo')}</span> Refazer</button></div>
      <div class="xs muted" id="selInfo">${n ? `${n} gôndola${n > 1 ? 's' : ''} selecionada${n > 1 ? 's' : ''}: ${ids.join(', ')}${tam}` : 'Nada selecionado'}</div>
      <div class="editbar"><button class="sm" id="sTudo">Selecionar tudo</button><button class="sm${M.multiToque ? ' primary' : ''}" id="sMulti" aria-pressed="${M.multiToque}" title="No celular, ligue para tocar em várias gôndolas">Selecionar várias</button></div>
      <div class="editbar"><button class="sm" id="sCopia"${dis(n)}>Copiar</button><button class="sm" id="sCola"${dis(M.clip)}>Colar</button><button class="sm" id="sDup"${dis(n)}>Duplicar</button><button class="sm danger" id="sExc"${dis(n)}>Excluir</button></div>
      <div><label class="f">Alinhar a seleção</label><div class="editbar">${al('esq', 'Esquerda')}${al('centro', 'Centro')}${al('dir', 'Direita')}${al('topo', 'Topo')}${al('meio', 'Meio')}${al('base', 'Base')}</div></div>
      <div><label class="f">Distribuir com vãos iguais <span class="muted">(3 ou mais)</span></label><div class="editbar"><button class="sm" data-dist="h"${dis(n >= 3)}>Na horizontal</button><button class="sm" data-dist="v"${dis(n >= 3)}>Na vertical</button></div></div>
      <details class="org" id="orgBox"${o.modo || o.aberto ? ' open' : ''}><summary>Organizar automaticamente</summary>
        <div class="org-corpo">
          <div class="xs muted">Vale para</div>
          <div class="seg" id="orgEsc" role="group" aria-label="Quais gôndolas organizar"><button data-esc="sel" aria-pressed="${o.escopo === 'sel' && n >= 2}"${dis(n >= 2)}>Selecionadas${n >= 2 ? ` (${n})` : ''}</button><button data-esc="todas" aria-pressed="${!(o.escopo === 'sel' && n >= 2)}">Todas</button></div>
          <div class="seg scrollx" id="orgModo" role="group" aria-label="Como organizar"><button data-m="alinhar" aria-pressed="${o.modo === 'alinhar'}">Alinhar linhas e colunas</button><button data-m="espaco" aria-pressed="${o.modo === 'espaco'}">Espaçamento igual</button><button data-m="grade" aria-pressed="${o.modo === 'grade'}">Grade ordenada</button></div>
          ${campo('alinhar espaco', `<label class="xs muted" for="orgTol">Tolerância para contar como mesma linha ou coluna (m)</label><input id="orgTol" type="number" min="0.1" max="5" step="0.1" value="${o.tol}">`)}
          ${campo('grade', `<div class="grid" style="grid-template-columns:1fr 1fr;gap:8px"><div><label class="xs muted" for="orgCol">Colunas (0 = automático)</label><input id="orgCol" type="number" min="0" max="40" step="1" value="${o.colunas}"></div>
            <div><label class="xs muted" for="orgCor">Corredor mínimo (m)</label><input id="orgCor" type="number" min="0.2" max="5" step="0.1" value="${o.corredorM}"></div></div>
            <label class="chk"><input type="checkbox" id="orgEnt"${o.entrada ? ' checked' : ''}> Deixar uma faixa livre para a entrada</label>
            <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px"><select id="orgLado" aria-label="Lado da entrada"${o.entrada ? '' : ' disabled'}>${[['baixo', 'Embaixo'], ['cima', 'Em cima'], ['esq', 'À esquerda'], ['dir', 'À direita']].map(([v, t]) => `<option value="${v}"${o.lado === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
              <input id="orgEM" type="number" min="0.5" max="30" step="0.5" value="${o.entradaM}" aria-label="Largura da faixa da entrada (m)"${o.entrada ? '' : ' disabled'}></div>`)}
          <div id="orgMsg" class="callout ${o.ok ? 'ok' : 'warn'}"${o.msg ? '' : ' hidden'}>${esc(o.msg)}</div>
          <div class="editbar"><button class="sm primary" id="orgAplica"${dis(M.previa && o.ok)}>Aplicar</button><button class="sm" id="orgCancela">Cancelar</button></div>
          <div class="xs muted">A prévia aparece na planta. Nada fica fora do perímetro nem sobreposto; se não couber, aparece o motivo.</div>
        </div></details>
      <div class="xs muted">Atalhos: Shift+clique soma · arrastar no vazio seleciona · Ctrl+A, C, V, D · Delete · setas (Shift = 10×) · Ctrl+Z / Ctrl+Y · Esc solta. Mover o mapa: Espaço+arrastar, botão do meio ou dois dedos.</div>
    </div>`;
  }
  function ligaSelecao() {
    const on = (q, f) => { const b = $(q); if (b) b.addEventListener('click', f); };
    on('#hDesf', desfaz); on('#hRef', refaz); on('#sTudo', selecionaTudo);
    on('#sMulti', () => { M.multiToque = !M.multiToque; desenhaLateral(); });
    on('#sCopia', () => { M.clip = capturaSel(); desenhaLateral(); toast(M.clip.itens.length > 1 ? `${M.clip.itens.length} gôndolas copiadas` : 'Gôndola copiada', 'ok', 1500); });
    on('#sCola', () => colaClip(M.clip, M.clip ? ++M.clip.n : 1));
    on('#sDup', () => colaClip(capturaSel(), 1));
    on('#sExc', excluiSel);
    $$('[data-al]').forEach(b => b.addEventListener('click', () => opAlinhar(b.dataset.al)));
    $$('[data-dist]').forEach(b => b.addEventListener('click', () => opDistribuir(b.dataset.dist)));
    const box = $('#orgBox'); if (!box) return;
    box.addEventListener('toggle', () => { M.org.aberto = box.open; if (!box.open) cancelaPrevia(); });
    $$('#orgModo button').forEach(b => b.addEventListener('click', () => { M.org.modo = b.dataset.m; calculaPrevia(); }));
    $$('#orgEsc button').forEach(b => b.addEventListener('click', () => { M.org.escopo = b.dataset.esc; $$('#orgEsc button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); if (M.org.modo) calculaPrevia(); }));
    const num = (q, k) => { const i = $(q); if (i) i.addEventListener('change', () => { M.org[k] = Math.max(+i.min, Math.min(+i.max, +i.value || 0)); i.value = M.org[k]; if (M.org.modo) calculaPrevia(); }); };
    num('#orgTol', 'tol'); num('#orgCol', 'colunas'); num('#orgCor', 'corredorM'); num('#orgEM', 'entradaM');
    const ent = $('#orgEnt'); if (ent) ent.addEventListener('change', () => { M.org.entrada = ent.checked; $('#orgLado').disabled = !ent.checked; $('#orgEM').disabled = !ent.checked; if (M.org.modo) calculaPrevia(); });
    const lado = $('#orgLado'); if (lado) lado.addEventListener('change', () => { M.org.lado = lado.value; if (M.org.modo) calculaPrevia(); });
    on('#orgAplica', aplicaPrevia); on('#orgCancela', () => { cancelaPrevia(); });
    atualizaBotoesHist();
  }

  // ----- teclado (só nos editores; ignorado quando o foco está num campo) -----
  function tecla(e) {
    if (!emEdicao() || !$('#canvas')) return;
    const alvo = e.target;
    if (alvo && alvo.closest && alvo.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
    if (k === 'escape') {
      if (M.previa) { cancelaPrevia(); return; }
      if (M.desenhando) return;                                            // o Esc do desenho já trata
      fixaSel([]); M.selCam = null; M.selPt = null; desenhaPalco(); desenhaLateral(); return;
    }
    if (k === ' ') {
      if (alvo && alvo.closest && alvo.closest('button, a, summary')) return;
      e.preventDefault(); M.espaco = true; const st = $('#stage'); if (st) st.classList.add('espaco'); return;
    }
    if (M.previa || M.gesto) return;                                       // com uma prévia aberta, só Esc (cancelar) e os botões Aplicar/Cancelar
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) refaz(); else desfaz(); return; }
    if (mod && k === 'y') { e.preventDefault(); refaz(); return; }
    if (mod && k === 'a') { e.preventDefault(); selecionaTudo(); return; }
    if (mod && k === 'c') { const c = capturaSel(); if (c) { e.preventDefault(); M.clip = c; desenhaLateral(); toast(c.itens.length > 1 ? `${c.itens.length} gôndolas copiadas` : 'Gôndola copiada', 'ok', 1500); } return; }
    if (mod && k === 'v') { if (M.clip) { e.preventDefault(); colaClip(M.clip, ++M.clip.n); } return; }
    if (mod && k === 'd') { e.preventDefault(); const c = capturaSel(); if (c) colaClip(c, 1); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { if (selIds().filter(existe).length) { e.preventDefault(); excluiSel(); } return; }
    const seta = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    if (seta && selIds().filter(existe).length) { e.preventDefault(); const p = e.shiftKey ? 10 : 1; nudge(seta[0] * p, seta[1] * p); }
  }
  function ligaTeclado() {
    if (M.tecladoLigado) return;
    M.tecladoLigado = true;
    const solta = () => { M.espaco = false; const st = $('#stage'); if (st) st.classList.remove('espaco'); };
    document.addEventListener('keydown', tecla);
    document.addEventListener('keyup', e => { if (e.key === ' ' && M.espaco) solta(); });
    window.addEventListener('blur', solta);
  }

  // ---------- criar desenhando no mapa ----------
  function ativaDesenho(tipo) {
    if (M.desenhando === tipo) return cancelaDesenho();
    M.desenhando = tipo;
    $('#stage').classList.add('desenhando');
    if (!M.escHandler) { M.escHandler = ev => { if (ev.key === 'Escape' && M.desenhando) cancelaDesenho(); }; document.addEventListener('keydown', M.escHandler); }
    desenhaAlcas(); desenhaLateral();
  }
  function cancelaDesenho() {
    M.desenhando = null;
    const st = $('#stage'); if (st) st.classList.remove('desenhando');
    desenhaAlcas(); desenhaLateral();
  }

  function iniciaDesenho(e) {
    const st = $('#stage'), r0 = st.getBoundingClientRect(), tipo = M.desenhando;
    const Lp = layoutEditavel(), mundo = ev => ({ x: limita(snap5((ev.clientX - r0.left - M.cam.tx) / M.cam.k), 0, Lp.largura), y: limita(snap5((ev.clientY - r0.top - M.cam.ty) / M.cam.k), 0, Lp.altura) });
    const a = mundo(e), rasc = document.createElement('div');
    rasc.className = 'rasc'; st.appendChild(rasc);
    const retDe = b => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
    const mover = ev => { const r = retDe(mundo(ev)); Object.assign(rasc.style, { left: r.x * M.cam.k + M.cam.tx + 'px', top: r.y * M.cam.k + M.cam.ty + 'px', width: r.w * M.cam.k + 'px', height: r.h * M.cam.k + 'px' }); };
    const fim = ev => {
      window.removeEventListener('pointermove', mover); window.removeEventListener('pointerup', fim); rasc.remove();
      const r = retDe(mundo(ev));
      cancelaDesenho();
      if (r.w < 12 || r.h < 8) { toast('Arraste para desenhar um retângulo maior', 'bad', 2500); return; }
      criaDesenhado(tipo, r);
    };
    mover(e);
    window.addEventListener('pointermove', mover); window.addEventListener('pointerup', fim);
  }

  function criaDesenhado(tipo, r) {
    const Lx = M.draftL, esc = escalaCm(), D = dim();
    if (tipo === 'pallet') {                                                         // pallet dentro da área selecionada
      const g = Lx.gondolas.find(x => x.id === M.sel), cf = M.draftG[M.sel];
      if (!g || !cf || !SACARIA(M.sel)) return;
      const c = caixa(g), kcm = c.w / c.aw;
      const usados = new Set((cf.pallets || []).map(p => p.id)); let id = 1; while (usados.has(id)) id++;
      const x = limita(snap5((r.x - c.x) / kcm), 0, (cf.c ?? 600) - 20), y = limita(snap5((r.y - c.y) / kcm), 0, (cf.l ?? 400) - 20);
      cf.pallets = cf.pallets || [];
      cf.pallets.push({ id, x, y, c: Math.min(limita(snap5(r.w / kcm), 20, 600), (cf.c ?? 600) - x), l: Math.min(limita(snap5(r.h / kcm), 20, 600), (cf.l ?? 400) - y), nome: '' });
      M.selPal = id; empilha(); desenhaPalco(); desenhaLateral(); toast('Pallet P' + id + ' criado', 'ok', 2000); return;
    }
    const ocupados = new Set([...Lx.gondolas.map(g => g.id), ...Object.keys(M.draftG).map(Number), ...M.data.gondolas.map(g => g.id)]);
    let id = null;
    for (let n = 20; n <= 40 && id === null; n++) if (!ocupados.has(n)) id = n;
    for (let n = 1; n < 20 && id === null; n++) if (!ocupados.has(n)) id = n;
    if (id === null) { toast('Não há número livre (1 a 40)', 'bad'); return; }
    let box;
    if (tipo === 'area') {
      const cf = { tipo: 'area', nome: '', c: limita(snap5(r.w / esc), 100, 3000), l: limita(snap5(r.h / esc), 100, 3000), pallets: [] };
      M.draftG[id] = cf; box = { id, x: r.x, y: r.y, w: cf.c * esc, h: cf.l * esc, rot: 0 };
    } else {
      const vert = PE_PD(id) || r.h > r.w, longo = vert ? r.h : r.w, curto = vert ? r.w : r.h;
      M.draftG[id] = { tipo: 'gondola', nome: '', lados: curto / esc < 1.3 * D.modulo_l ? 'B' : 'AB', modulos: limita(Math.round((longo / esc - 2 * D.ponta_p) / D.modulo_c), 1, U_NIVEIS), dim: null, nomes: {} };
      const gm = geomG(id);
      box = { id, x: r.x, y: r.y, w: (vert ? gm.T : gm.L) * esc, h: (vert ? gm.L : gm.T) * esc, rot: vert ? 90 : 0 };
    }
    Lx.gondolas.push(box); fixaSel([id]); M.selPal = null; M.shelf = null; empilha();
    desenhaPalco(); desenhaLateral(); toast(`${tipo === 'area' ? 'Área' : 'Gôndola'} ${id} desenhada — dê um nome e ajuste pelas alças`, 'ok', 3500);
  }

  // abre/seleciona uma gôndola: painel por cima e câmera aproximada
  function escolheGondola(id, chave, pal) {
    const mudou = M.sel !== id;
    fixaSel([id]); M.selPal = pal ?? null;
    if (chave && /^[AB]-/.test(chave)) M.lado = chave[0];
    if (chave) M.shelf = { g: id, chave }; else if (mudou) M.shelf = null;
    if (M.edit || M.editG) { desenhaPalco(); desenhaLateral(); return; }
    desenhaLateral();
    if (mudou) focaGondola(id); else desenhaPalco();
  }

  // Dica do módulo (prateleira) sob o mouse: o que está ali, do que vence primeiro ao último
  function tipCelula(id, c, r) {
    const itens = (c.itens || []).slice(0, 4), resto = (c.itens || []).length - itens.length;
    return `<b>${esc(enderecoDe(id, c.chave))}</b> · ${esc(rotuloG(id))}${r ? ' · ' + esc(r) : ''}<br>${c.lotes} lote${c.lotes > 1 ? 's' : ''} · ${int(c.qtd)} ${c.qtd > 1 ? 'itens' : 'item'}${c.valor ? ' · ' + brl(c.valor) : ''}${c.risco ? '<br>Em risco ' + brl(c.risco) : ''}`
      + itens.map(i => `<br><span class="tip-i" style="--c:${esc(i.cor || '#888')}"></span>${esc((i.nome || i.ean).slice(0, 34))} · ${i.qtd} un · ${i.dias <= 0 ? 'vencido' : 'em ' + i.dias + ' d'}`).join('')
      + (resto > 0 ? `<br><span class="faint">+ ${resto} lote${resto > 1 ? 's' : ''}</span>` : '')
      + (c.dias_sem_ronda === null ? '<br>Nunca contada' : '<br>Ronda há ' + c.dias_sem_ronda + ' d');
  }

  function ligaPalco() {
    const tip = $('#tip');
    $$('#canvas .gon').forEach(el => {
      const id = +el.dataset.g;
      el.addEventListener('click', e => {
        if (M.suprime) return;
        if (emEdicao()) {                                  // a seleção já foi feita ao apertar (iniciaMover); aqui só teclado e pallets
          if (e.detail === 0) { escolheGondola(id); return; }
          if (M.editG && M.sel === id) {
            const pal = e.target.closest('.mp-cel[data-pal]'), p = pal ? +pal.dataset.pal : null;
            if (p !== M.selPal) { M.selPal = p; desenhaPalco(); desenhaLateral(); }
          }
          return;
        }
        const cel = e.target.closest('.mp-cel[data-chave]');
        if (cel && el.classList.contains('perto') && !M.edit && !M.editG) { escolheGondola(id, cel.dataset.chave); return; }
        if (!M.edit && !M.editG && M.sel === id && el.classList.contains('perto')) return;
        escolheGondola(id);
      });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || (e.key === ' ' && !emEdicao())) { e.preventDefault(); el.click(); } });
      el.addEventListener('mousemove', e => {
        if (M.edit || M.editG) return;
        const d = M.data.gondolas.find(g => g.id === id);
        const r = respGondola(id);
        const cel = e.target.closest('.mp-cel[data-chave]');
        const c = d && cel ? d.celulas.find(x => x.chave === cel.dataset.chave) : null;
        if (c) tip.innerHTML = tipCelula(id, c, r);
        else tip.innerHTML = d ? `<b>${esc(rotuloG(id))}</b>${r ? ' · ' + esc(r) : ''}<br>${d.lotes} lotes · ${int(d.qtd)} itens<br>Valor ${brl(d.valor)}<br>${d.risco ? 'Em risco ' + brl(d.risco) + '<br>' : ''}Pior: ${esc(d.pior || '—')}${d.nunca_contada ? '<br>Nunca contada' : d.dias_sem_ronda !== null ? '<br>Ronda há ' + d.dias_sem_ronda + ' d' : ''}` : `<b>${esc(rotuloG(id))}</b><br>sem estoque`;
        tip.style.left = Math.min(innerWidth - 250, e.clientX + 16) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; tip.classList.add('on');
      });
      el.addEventListener('mouseleave', () => tip.classList.remove('on'));
      if (emEdicao()) el.addEventListener('pointerdown', e => iniciaMover(e, id));
    });
  }

  // ---------- caminhos de fluxo (camada em pixels de tela, sobre o mapa) ----------
  // Cada caminho é uma linha de 2 a 30 pontos (reta ou curva suave) com seta no fim. Bifurcar = outro caminho que sai de um ponto.
  const caminhosDe = L => L.caminhos || (L.setas || []).map(a => { const r = (a.rot || 0) * Math.PI / 180, c = a.c || 80; return { curva: false, pts: [{ x: a.x, y: a.y }, { x: a.x + Math.cos(r) * c, y: a.y + Math.sin(r) * c }] }; });

  function dCaminho(pts, curva) {
    const P = pts.map(p => ({ x: p.x * M.cam.k + M.cam.tx, y: p.y * M.cam.k + M.cam.ty }));
    let d = `M${P[0].x} ${P[0].y}`, fim = P[P.length - 1], ang = 0;
    if (!curva || P.length < 3) {
      for (let i = 1; i < P.length; i++) d += ` L${P[i].x} ${P[i].y}`;
      const a = P[P.length - 2]; ang = Math.atan2(fim.y - a.y, fim.x - a.x);
    } else {          // curva suave passando por todos os pontos (Catmull-Rom convertida em Bézier)
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
        d += ` C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
        if (i === P.length - 2) ang = Math.atan2(p2.y - c2.y, p2.x - c2.x);
      }
    }
    const h = 13, ca = Math.cos(ang), sa = Math.sin(ang);
    const seta = `M${fim.x} ${fim.y} L${fim.x - h * ca + h * 0.5 * sa} ${fim.y - h * sa - h * 0.5 * ca} L${fim.x - h * ca - h * 0.5 * sa} ${fim.y - h * sa + h * 0.5 * ca} Z`;
    return { d, seta, P };
  }

  function desenhaFluxo() {
    const svg = $('#fluxo');
    if (!svg || !M.cam) return;
    const cs = caminhosDe(layoutExibido()), ed = M.edit;
    svg.classList.toggle('edit', !!ed);
    svg.innerHTML = cs.map((c, i) => {
      const { d, seta, P } = dCaminho(c.pts, c.curva), sel = ed && M.selCam === i;
      return `<g class="cam${sel ? ' sel' : ''}" data-c="${i}"><path class="cam-hit" d="${d}"/><path class="cam-linha" d="${d}"/><path class="cam-seta" d="${seta}"/>` +
        (sel ? P.map((p, j) => `<circle class="cam-no${M.selPt === j ? ' sel' : ''}" data-p="${j}" cx="${p.x}" cy="${p.y}" r="7"/>`).join('') : '') + '</g>';
    }).join('');
    if (ed) ligaFluxo(svg);
  }

  function pontoDoMundo(e) {
    const r = $('#stage').getBoundingClientRect();
    return { x: (e.clientX - r.left - M.cam.tx) / M.cam.k, y: (e.clientY - r.top - M.cam.ty) / M.cam.k };
  }

  function ligaFluxo(svg) {
    const L = M.draft;
    $$('.cam', svg).forEach(g => {
      const i = +g.dataset.c;
      $$('.cam-hit, .cam-linha, .cam-seta', g).forEach(p => {
        p.addEventListener('pointerdown', e => { e.stopPropagation(); if (M.selCam !== i) { M.selCam = i; M.selPt = null; desenhaFluxo(); desenhaLateral(); } });
        p.addEventListener('dblclick', e => {            // dois cliques na linha criam um ponto ali
          e.stopPropagation();
          const w = pontoDoMundo(e), pts = L.caminhos[i].pts;
          let melhor = 0, dist = Infinity;
          for (let j = 0; j < pts.length - 1; j++) {
            const a = pts[j], b = pts[j + 1], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
            const dd = Math.hypot(w.x - (a.x + t * dx), w.y - (a.y + t * dy));
            if (dd < dist) { dist = dd; melhor = j; }
          }
          pts.splice(melhor + 1, 0, { x: Math.round(w.x / 5) * 5, y: Math.round(w.y / 5) * 5 });
          M.selCam = i; M.selPt = melhor + 1; empilha(); desenhaFluxo(); desenhaLateral();
        });
      });
      $$('.cam-no', g).forEach(n => n.addEventListener('pointerdown', e => {
        e.stopPropagation(); e.preventDefault();
        const j = +n.dataset.p, pt = L.caminhos[i].pts[j], k = M.cam.k;
        M.selPt = j;
        // pontos de outros caminhos no mesmo lugar (bifurcações) acompanham o arrasto
        const juntos = L.caminhos.flatMap(c => c.pts).filter(q => q !== pt && Math.abs(q.x - pt.x) < 0.6 && Math.abs(q.y - pt.y) < 0.6);
        const x0 = e.clientX, y0 = e.clientY, px = pt.x, py = pt.y, outros = juntos.map(q => [q, q.x, q.y]);
        const mover = ev => {
          const nx = Math.round((px + (ev.clientX - x0) / k) / 5) * 5, ny = Math.round((py + (ev.clientY - y0) / k) / 5) * 5;
          pt.x = nx; pt.y = ny; outros.forEach(([q]) => { q.x = nx; q.y = ny; });
          desenhaFluxo();
        };
        const fim = () => { window.removeEventListener('pointermove', mover); window.removeEventListener('pointerup', fim); empilha(); desenhaLateral(); };
        window.addEventListener('pointermove', mover); window.addEventListener('pointerup', fim);
      }));
    });
  }

  // ---------- vista de frente (como uma pessoa olhando as prateleiras de um lado da gôndola) ----------
  const ladoFrente = () => { const l = ladosG(M.sel); return l.includes(M.lado) ? M.lado : l[0]; };

  function desenhaFrente() {
    const el = $('#frente');
    if (!el) return;
    if (M.edit || M.editG || M.sel === null || SACARIA(M.sel) || M.vista === 'grade' && innerWidth < 700) { el.hidden = true; el.innerHTML = ''; M.frenteKey = null; return; }
    const id = M.sel, d = M.data.gondolas.find(g => g.id === id), lado = ladoFrente(), n = nMod(id), p = pontasDe(id), s = setor(id, lado);
    // Quem olha o lado B está "em cima" do desenho, olhando para baixo: a esquerda dele é o lado direito do desenho. No lado A é o contrário.
    const ordem = Array.from({ length: n }, (_, i) => i + 1).sort((a, b) => (lado === 'B' ? colunaDoModulo(id, b) - colunaDoModulo(id, a) : colunaDoModulo(id, a) - colunaDoModulo(id, b)));
    const esq = lado === 'B' ? p.dir : p.esq, dir = lado === 'B' ? p.esq : p.dir;
    const nomes = cfgG(id).nomes || {};
    const ponta = l => {
      const c = celulaPonta(d, l), k = calor(c, true), st = setor(id, l);
      return `<button class="fr-ponta${c ? '' : ' vazia'}" ${c ? `data-chave="${esc(c.chave)}"` : 'disabled'} style="${c && !k.vazio ? `--hc:${k.bg};--hi:${k.ink}` : ''}" title="${esc(NOME_LADO[l])}${st.nome ? ' · ' + esc(st.nome) : ''}">
        <b>${esc(l)}</b>${c ? `<span>${c.lotes}</span>` : ''}</button>`;
    };
    const modulo = m => {
      const chave = `${lado}-${m}`, c = d ? d.celulas.find(z => z.chave === chave) : null, k = calor(c, true), nome = nomes[chave];
      const sel = M.shelf && M.shelf.g === id && M.shelf.chave === chave;
      let corpo = '<div class="fr-vazio">sem lotes</div>';
      if (c) {
        const por = new Map();
        for (const it of c.itens) { const x = por.get(it.status) || { cor: it.cor, n: 0 }; x.n++; por.set(it.status, x); }
        const etq = c.itens.filter(it => it.etiquetar).length;
        corpo = `<div class="fr-st">${esc(c.pior)}</div>
          <div class="fr-lin"><b>${c.lotes}</b> lote${c.lotes > 1 ? 's' : ''} · ${int(c.qtd)} un</div>
          <div class="fr-lin">${c.risco ? 'Em risco <b>' + brl(c.risco) + '</b>' : 'Sem risco'}</div>
          <div class="fr-bar" title="Lotes por status">${[...por].map(([st, x]) => `<i style="flex:${x.n};background:${esc(x.cor)}" title="${esc(st)}: ${x.n}"></i>`).join('')}</div>
          <div class="fr-chips">${c.vencidos ? `<span class="fr-c bad">${c.vencidos} vencido${c.vencidos > 1 ? 's' : ''}</span>` : ''}${c.criticos ? `<span class="fr-c warn">${c.criticos} ≤ 30 d</span>` : ''}${etq ? `<span class="fr-c tag">${etq} p/ etiquetar</span>` : ''}</div>
          <div class="fr-lin xs">${c.dias_sem_ronda === null || c.dias_sem_ronda === undefined ? 'nunca contado' : 'ronda há ' + c.dias_sem_ronda + ' d'}</div>`;
      }
      return `<button class="fr-mod${sel ? ' sel' : ''}${c ? '' : ' vazia'}" ${c ? `data-chave="${esc(chave)}"` : 'disabled'} style="${c && !k.vazio ? `--hc:${k.bg};--hi:${k.ink}` : ''}" aria-label="${esc(enderecoDe(id, chave))}">
        <div class="fr-h"><b>${m}</b><span>${esc(nome || '')}</span></div>${corpo}</button>`;
    };
    el.hidden = false;
    const chaveF = id + '|' + lado; el.classList.toggle('entra', chaveF !== M.frenteKey); M.frenteKey = chaveF;
    el.innerHTML = `<div class="card reveal"><div class="head"><div><h2>${esc(rotuloG(id))} · ${esc(NOME_LADO[lado])} visto de frente</h2>
        <div class="sub">${s.nome ? esc(s.nome) + ' · ' : ''}${s.resp.length ? esc(respTxt(s)) + ' · ' : ''}como quem está no corredor olhando as prateleiras: esquerda e direita são as suas</div></div>
        ${ladosG(id).length > 1 ? `<div class="seg" id="frLado" role="group" aria-label="Lado visto">${ladosG(id).map(l => `<button data-lado="${l}" aria-pressed="${l === lado}">${esc(NOME_LADO[l])}</button>`).join('')}</div>` : ''}</div>
      <div class="fr-row">${ponta(esq)}${ordem.map(modulo).join('')}${ponta(dir)}</div></div>`;
    $$('#frLado button', el).forEach(b => b.addEventListener('click', () => { M.lado = b.dataset.lado; desenhaFrente(); }));
    $$('.fr-mod[data-chave], .fr-ponta[data-chave]', el).forEach(b => b.addEventListener('click', () => {
      M.shelf = { g: id, chave: b.dataset.chave }; if (/^[AB]-/.test(b.dataset.chave)) M.lado = b.dataset.chave[0];
      desenhaPalco(); desenhaLateral();
    }));
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
      ${SACARIA(g.id) ? '' : `<div style="margin:0 0 10px"><button class="sm" id="vFrente">${ico('chevron')} Ver de frente (abaixo do mapa)</button></div>`}
      <h3 style="margin:2px 0 4px">Setores</h3>${lados.map(resumoLado).join('')}
      ${geral ? `<div style="margin-top:12px"><h3 style="margin-bottom:6px">Sem lado/prateleira definidos</h3><button class="shelf" data-chave="geral" style="--hc:${calor(geral, true).bg};--hi:${calor(geral, true).ink}"><span class="lv">?</span><span><span class="nm">${esc(geral.pior)}</span><br><span class="vl">${geral.lotes} lote${geral.lotes > 1 ? 's' : ''} · ${int(geral.qtd)} un</span></span><span class="vl"></span></button><p class="xs muted" style="margin-top:6px">Esses lotes estão só com o número da gôndola. Na próxima ronda, informe lado e prateleira (ex.: ${g.id}-A-1).</p></div>` : ''}
      ${itens || '<p class="xs muted" style="margin-top:12px">Toque num módulo da vista de cima para ver os lotes dele.</p>'}</div>`;
  }

  function lateralEdicao() {
    const L = M.draft, g = L.gondolas.find(x => x.id === M.sel), cam = M.selCam !== null ? L.caminhos[M.selCam] : null;
    const livres = [...new Set([...Array.from({ length: 19 }, (_, i) => i + 1), ...Object.keys(cfgTodas()).map(Number)])].sort((a, b) => a - b).filter(n => !L.gondolas.some(x => x.id === n));
    const esc2 = escalaPx(), mt = px => Math.round(Geom.pxParaM(px, esc2) * 10) / 10;       // perímetro em metros reais (px = cm × escala)
    return `<div class="card drawer"><div class="head"><div><h2>Editar planta</h2><div class="sub">Arraste as gôndolas e as setas. O tamanho de cada gôndola vem das medidas em cm: as bolinhas mudam essas medidas, igual a Editar gôndolas.</div></div></div>
      <div class="grid" style="gap:14px">
        ${blocoSelecao()}
        <div><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="f" for="eLarg">Largura da loja (m)</label><input id="eLarg" type="number" min="${mt(400)}" max="${mt(4000)}" step="0.5" value="${mt(L.largura)}"></div>
          <div><label class="f" for="eAlt">Comprimento da loja (m)</label><input id="eAlt" type="number" min="${mt(300)}" max="${mt(4000)}" step="0.5" value="${mt(L.altura)}"></div></div>
          <div class="xs muted" style="margin-top:6px">Escala do mapa: ${fmtM(esc2)} px por cm (${fmtM(esc2 * 100)} px por metro).</div></div>
        <div><label class="f">Medidas padrão das prateleiras (cm)</label><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">${CAMPOS_DIM.map(([k, r]) => `<div><label class="xs muted" for="ed_${k}">${r}</label><input id="ed_${k}" data-edim="${k}" type="number" min="10" max="300" value="${dim()[k]}"></div>`).join('')}</div></div>
        <div><label class="f">Planta da loja (imagem de fundo)</label>
          <div class="editbar"><label class="btn sm" style="cursor:pointer">${ico('image')} Enviar imagem<input id="eFundo" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${L.fundo ? `<button class="sm danger" id="eSemFundo">Remover</button>` : ''}</div>
          ${L.fundo ? `<label class="f" style="margin-top:10px">Transparência da imagem</label><input id="eOp" type="range" min="0" max="1" step="0.05" value="${L.fundo_opacidade}" style="min-height:24px;padding:0">` : ''}</div>
        <div><label class="f">Perímetro da loja</label><div class="editbar">${botaoPerim()}</div><div class="xs muted" style="margin-top:6px">A linha fina é o limite da planta: as gôndolas não saem dele e se alinham a ele. Arraste as bolinhas para mudar o tamanho.</div></div>
        <div><label class="f">Gôndola selecionada</label>${selIds().length ? `<div class="editbar"><b style="font-size:18px">${selIds().join(', ')}</b><button class="sm" id="eGira">${ico('rotate')} Girar</button><button class="sm danger" id="eRemove">${ico('minus')} Tirar da planta</button></div>` : '<p class="small muted">Clique numa gôndola para selecionar (Shift+clique soma, ou arraste no vazio).</p>'}</div>
        ${livres.length ? `<div><label class="f">Adicionar gôndola</label><div class="editbar">${livres.map(n => `<button class="sm" data-add="${n}">${n}</button>`).join('')}</div></div>` : ''}
        <div><label class="f">Caminhos de fluxo <span class="muted">(por onde os clientes andam)</span></label>
          <div class="editbar"><button class="sm" id="cNovo">${ico('plus')} Novo caminho</button>${cam ? `<button class="sm" id="cCurva">${cam.curva ? 'Deixar reto' : 'Curvar'}</button><button class="sm danger" id="cRem">${ico('minus')} Remover caminho</button>` : ''}</div>
          ${cam ? `<div class="editbar" style="margin-top:8px"><button class="sm" id="cBif" ${M.selPt === null ? 'disabled' : ''}>Bifurcar do ponto</button><button class="sm" id="cRemPt" ${M.selPt === null || cam.pts.length <= 2 ? 'disabled' : ''}>Remover ponto</button></div>
            <div class="xs muted" style="margin-top:6px">Arraste os pontos. Dois cliques na linha criam um ponto. Clique num ponto para bifurcar ou removê-lo.</div>` : '<p class="xs muted" style="margin-top:6px">Clique numa seta para editar, ou crie um novo caminho.</p>'}</div>
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
          ${c.pallets.map((p, i) => `<div class="pal${M.selPal === p.id ? ' sel' : ''}" data-i="${i}"><b>P${p.id}</b><input data-k="nome" placeholder="Nome" maxlength="40" value="${esc(p.nome || '')}" aria-label="Nome do pallet ${p.id}">
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
        ${blocoSelecao()}
        <div><label class="f">Criar desenhando no mapa</label>
          <div class="editbar"><button class="sm${M.desenhando === 'gondola' ? ' primary' : ''}" id="gDesGond">${ico('edit')} Desenhar gôndola</button><button class="sm${M.desenhando === 'area' ? ' primary' : ''}" id="gDesArea">${ico('edit')} Desenhar área livre</button>${botaoPerim()}${id !== null && SACARIA(id) ? `<button class="sm${M.desenhando === 'pallet' ? ' primary' : ''}" id="gDesPal">${ico('edit')} Desenhar pallet</button>` : ''}</div>
          ${M.desenhando ? '<div class="callout" style="margin-top:8px">' + ico('info') + '<div>Clique e arraste no mapa para desenhar o retângulo. <b>Esc</b> cancela.</div></div>' : '<div class="xs muted" style="margin-top:6px">Clique e arraste no mapa, como num CAD. Depois ajuste o tamanho pelas alças nos quatro lados e nos cantos.</div>'}</div>
        ${nova}
        <div><label class="f" for="gSel">Gôndola</label><select id="gSel"><option value="">Escolha…</option>${ids.map(i => `<option value="${i}" ${i === id ? 'selected' : ''}>${i} · ${esc(((M.draftG[i] || {}).nome) || (i === 19 ? 'Sacaria de gatos' : 'Gôndola'))}</option>`).join('')}</select></div>
        ${corpo}
        <div class="editbar" style="justify-content:flex-end"><button id="gCancela">Cancelar</button><button class="primary" id="gSalva">${ico('check')} Salvar gôndolas</button></div>
      </div></div>`;
  }

  // posição inicial de uma gôndola nova na planta (embaixo, em fila)
  function caixaInicial(L, id) {
    const vert = PE_PD(id), t = Geom.tamanhoCaixa(geomG(id), vert ? 90 : 0, escalaPx()), n = L.gondolas.length;      // tamanho vem das medidas em cm
    return { id, x: 60 + (n % 5) * 190, y: Math.min(L.altura - 60, 60 + Math.floor(n / 5) * 90), w: r1(t.w), h: r1(t.h), rot: vert ? 90 : 0 };
  }

  // sai do editor descartando o rascunho (ou depois de salvar)
  function fechaEdicao() {
    cancelaDesenho(); clearTimeout(M.nudgeT);
    M.edit = false; M.editG = false; M.draft = null; M.draftL = null; M.draftG = null; M.draftDim = null; M.hist = null; M.previa = null; M.multi = [];
    M.sel = null; M.selPal = null; M.selCam = null; M.selPt = null; M.selPerim = false; M.guias = [];
    montaTudo();
  }

  // grava medidas padrão e configuração das gôndolas (só se mudaram) e depois a planta, com as caixas já derivadas das medidas
  async function salvaTudo() {
    cancelaPrevia(false);
    const L = layoutEditavel();
    Geom.sincronizaCaixas(L, id => geomG(id));
    const mudou = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
    if (mudou(M.draftDim, M.data.dimensoes)) M.data.dimensoes = await api('/api/dimensoes', { method: 'PUT', body: M.draftDim });
    if (mudou(M.draftG, M.data.gondolas_cfg || {})) {
      M.data.gondolas_cfg = await api('/api/gondolas', { method: 'PUT', body: M.draftG });
      M.data.areas = Object.entries(M.data.gondolas_cfg).filter(([, v]) => v.tipo === 'area').map(([k]) => +k);
    }
    M.data.layout = await api('/api/layout', { method: 'PUT', body: { ...L, provisorio: false } });
  }

  function ligaEdicaoG() {
    const id = M.sel, c = id !== null ? M.draftG[id] : null;
    const redesenha = () => desenhaPalco();
    ligaSelecao();
    $('#gSel').addEventListener('change', e => { fixaSel(e.target.value ? [+e.target.value] : []); desenhaPalco(); desenhaLateral(); });
    ligaPerim();
    $('#gDesGond').addEventListener('click', () => ativaDesenho('gondola'));
    $('#gDesArea').addEventListener('click', () => ativaDesenho('area'));
    const dp = $('#gDesPal'); if (dp) dp.addEventListener('click', () => ativaDesenho('pallet'));
    const nova = $('#gnCria');
    if (nova) {
      $('#gnTipo').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) $$('#gnTipo button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
      nova.addEventListener('click', () => {
        const n = +$('#gnNum').value, tipo = $('#gnTipo button[aria-pressed=true]').dataset.t, nome = $('#gnNome').value.trim();
        M.draftG[n] = tipo === 'area' ? { tipo, nome, c: 600, l: 400, pallets: [] } : { tipo, nome, lados: 'AB', modulos: 5, dim: null, nomes: {} };
        M.draftL.gondolas.push(caixaInicial(M.draftL, n));
        fixaSel([n]); M.selPal = null; empilha(); desenhaPalco(); desenhaLateral();
      });
    }
    $('#gCancela').addEventListener('click', fechaEdicao);
    $('#gSalva').addEventListener('click', async () => {
      try { await salvaTudo(); toast('Gôndolas salvas', 'ok'); fechaEdicao(); } catch (er) { toast(er.message, 'bad', 5000); }
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
      delete M.draftG[id]; M.draftL.gondolas = M.draftL.gondolas.filter(g => g.id !== id); M.sel = null; M.selPal = null; desenhaPalco(); desenhaLateral();
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
        row.addEventListener('click', e => { if (e.target.closest('input, button')) return; M.selPal = p.id; desenhaPalco(); desenhaLateral(); });
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
    desenhaFrente();
    if (!el) return;
    const editando = M.editG || M.edit, aberto = editando || M.sel !== null;
    const cp = $('#cPainel'); if (cp) cp.hidden = !editando;
    ['#cDesf', '#cRef'].forEach(q => { const b = $(q); if (b) b.hidden = !editando; });
    const dica = $('#dicaEdit'); if (dica) dica.hidden = !editando;
    el.hidden = !aberto || (editando && M.painelMin);
    if (!aberto) { el.innerHTML = ''; return; }
    if (M.editG) { el.innerHTML = lateralEdicaoG(); ligaEdicaoG(); return; }
    if (M.edit) { el.innerHTML = lateralEdicao(); ligaEdicao(); return; }
    el.innerHTML = lateralGondola();
    $('#fecha', el).addEventListener('click', () => { M.sel = null; M.shelf = null; desenhaPalco(); desenhaLateral(); if (M.vista !== 'grade') { enquadra(true); setTimeout(agendaDetalhe, 620); } });
    $$('.shelf[data-chave]', el).forEach(b => b.addEventListener('click', () => { M.shelf = { g: M.sel, chave: b.dataset.chave }; desenhaPalco(); desenhaLateral(); }));
    const vf = $('#vFrente', el); if (vf) vf.addEventListener('click', () => { const f = $('#frente'); if (f && !f.hidden) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  function ligaEdicao() {
    const L = M.draft;
    L.caminhos = caminhosDe(L); delete L.setas;
    ligaPerim(); ligaSelecao();
    // perímetro em metros reais: px = m × 100 × escala (o valor guardado continua em px)
    const minPx = (eixo, piso) => Math.max(piso, ...L.gondolas.map(g => { const c = caixa(g); return Math.ceil(eixo === 'x' ? c.x + c.w : c.y + c.h); }));
    const perimM = (q, campo, eixo, piso) => $(q).addEventListener('change', e => {
      const px = Geom.limita(Math.round(Geom.mParaPx(+e.target.value || 0, escalaPx()) * 10) / 10, minPx(eixo, piso), 4000);
      L[campo] = px; e.target.value = Math.round(Geom.pxParaM(px, escalaPx()) * 10) / 10; desenhaPalco();
    });
    perimM('#eLarg', 'largura', 'x', 400); perimM('#eAlt', 'altura', 'y', 300);
    $$('[data-edim]').forEach(inp => inp.addEventListener('change', () => { M.draftDim[inp.dataset.edim] = +inp.value; desenhaPalco(); }));      // muda as medidas padrão: as caixas se redimensionam na hora
    const op = $('#eOp'); if (op) op.addEventListener('input', e => { L.fundo_opacidade = +e.target.value; const bg = $('#canvas .bg'); if (bg) bg.style.opacity = L.fundo_opacidade; });
    const sf = $('#eSemFundo'); if (sf) sf.addEventListener('click', () => { L.fundo = null; desenhaPalco(); desenhaLateral(); });
    $('#eFundo').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { L.fundo = await reduzImagem(f); desenhaPalco(); desenhaLateral(); } catch (er) { toast(er.message, 'bad'); }
    });
    const gi = $('#eGira'); if (gi) gi.addEventListener('click', giraSel);
    const rm = $('#eRemove'); if (rm) rm.addEventListener('click', excluiSel);
    $$('[data-add]').forEach(b => b.addEventListener('click', () => {
      const id = +b.dataset.add, vert = PE_PD(id), t = Geom.tamanhoCaixa(geomG(id), vert ? 90 : 0, escalaPx());
      L.gondolas.push({ id, x: 60 + (id % 5) * 40, y: 60, w: r1(t.w), h: r1(t.h), rot: vert ? 90 : 0 }); fixaSel([id]); M.selCam = null; M.selPt = null; empilha(); desenhaPalco(); desenhaLateral();
    }));
    const cs = L.caminhos;
    $('#cNovo').addEventListener('click', () => { const x = Math.round(L.largura / 2 / 5) * 5, y = Math.round(L.altura / 2 / 5) * 5; cs.push({ curva: false, pts: [{ x: x - 60, y }, { x: x + 60, y }] }); M.selCam = cs.length - 1; M.selPt = null; desenhaPalco(); desenhaLateral(); });
    const cu = $('#cCurva'); if (cu) cu.addEventListener('click', () => { cs[M.selCam].curva = !cs[M.selCam].curva; desenhaFluxo(); desenhaLateral(); });
    const cr = $('#cRem'); if (cr) cr.addEventListener('click', () => { cs.splice(M.selCam, 1); M.selCam = null; M.selPt = null; desenhaFluxo(); desenhaLateral(); });
    const cb = $('#cBif'); if (cb) cb.addEventListener('click', () => { const p = cs[M.selCam].pts[M.selPt]; cs.push({ curva: false, pts: [{ x: p.x, y: p.y }, { x: p.x + 70, y: p.y + 40 }] }); M.selCam = cs.length - 1; M.selPt = 1; desenhaFluxo(); desenhaLateral(); });
    const cp = $('#cRemPt'); if (cp) cp.addEventListener('click', () => { cs[M.selCam].pts.splice(M.selPt, 1); M.selPt = null; desenhaFluxo(); desenhaLateral(); });
    $('#eCancela').addEventListener('click', fechaEdicao);
    $('#eSalva').addEventListener('click', async () => {
      try { await salvaTudo(); toast('Planta salva', 'ok'); fechaEdicao(); } catch (er) { toast(er.message, 'bad', 5000); }
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
    if (M.cam && M.cam.fit) M.cam = null;
    v.innerHTML = `
      <div class="editbar reveal" style="margin-bottom:12px;justify-content:space-between">
        <div class="seg" role="group" aria-label="O que mostrar no mapa">${Object.entries(METRICAS).map(([k, m]) => `<button data-metric="${k}" aria-pressed="${M.metric === k}" title="${esc(m.desc)}">${m.nome}</button>`).join('')}</div>
        <div class="editbar">${legenda()}${!M.edit && !M.editG ? `<div class="seg" role="group" aria-label="Visualização"><button data-vista="grade" aria-pressed="${M.vista === 'grade'}">Grade</button><button data-vista="planta" aria-pressed="${M.vista === 'planta'}">Planta</button></div>` : ''}${M.ctx.admin && !M.edit && !M.editG ? `<button id="editar">${ico('edit')} Editar planta</button><button id="editarG">${ico('edit')} Editar gôndolas</button>` : ''}</div>
      </div>
      ${L.provisorio && !M.edit ? `<div class="callout reveal" style="--i:1;margin-bottom:12px">${ico('info')}<div><b>Planta provisória.</b> As gôndolas estão em grade só para você já enxergar os dados. ${M.ctx.admin ? 'Clique em <b>Editar planta</b> para arrastar cada gôndola até a posição real, aplicar a proporção real, desenhar as setas de fluxo e enviar a imagem do layout da loja como fundo.' : 'Peça a um administrador para montar a planta real.'}</div></div>` : ''}
      <div id="orfas" style="margin-bottom:12px"></div>
      <div class="stage-wrap">
        <div class="stage reveal" style="--i:2" id="stage" aria-label="Mapa da loja: arraste para mover, role ou use pinça para aproximar"></div>
        <div class="ctrls" id="ctrls"><button id="cMais" aria-label="Aproximar">${ico('plus')}</button><button id="cMenos" aria-label="Afastar">${ico('minus')}</button><button id="cFit" aria-label="Ver a loja toda">${ico('map')}</button><button id="cPainel" aria-label="Mostrar ou esconder o painel" hidden>${ico('sliders')}</button><button id="cDesf" aria-label="Desfazer" title="Desfazer (Ctrl+Z)" hidden>${ico('undo')}</button><button id="cRef" class="flip" aria-label="Refazer" title="Refazer (Ctrl+Y)" hidden>${ico('undo')}</button></div>
        <div class="dica-edit" id="dicaEdit" hidden>Arraste no vazio para selecionar · dois dedos movem o mapa (no PC: Espaço+arrastar ou botão do meio) · Shift+clique ou “Selecionar várias” soma</div>
        <div id="lateral" class="ov" hidden></div>
      </div>
      <div id="frente" class="frente" hidden></div>
      <div class="tip" id="tip"></div>`;
    $$('[data-metric]', v).forEach(b => b.addEventListener('click', () => { M.metric = b.dataset.metric; lsSet('mapaMetrica', M.metric); montaTudo(); }));
    $$('[data-vista]', v).forEach(b => b.addEventListener('click', () => { M.vista = b.dataset.vista; lsSet('mapaVista', M.vista); montaTudo(); }));
    const ed = $('#editar', v);
    const edg = $('#editarG', v);
    // os dois editores usam o mesmo rascunho: planta (layout), configuração das gôndolas e medidas padrão
    const abreEdicao = qual => {
      const dados = JSON.parse(JSON.stringify(M.data.layout));
      dados.caminhos = caminhosDe(dados); delete dados.setas;
      M.draftG = JSON.parse(JSON.stringify(M.data.gondolas_cfg || {})); M.draftDim = { ...(M.data.dimensoes || Geom.DIM0) };
      if (qual === 'G') { M.editG = true; M.draftL = dados; M.selPal = null; M.desenhando = null; } else { M.edit = true; M.draft = dados; }
      M.painelMin = false; M.sel = null; M.multi = []; M.selCam = null; M.selPt = null; M.selPerim = false; M.shelf = null; M.multiToque = false;
      iniciaHist(); montaTudo();
    };
    if (edg) edg.addEventListener('click', () => abreEdicao('G'));
    if (ed) ed.addEventListener('click', () => abreEdicao('P'));
    ligaTeclado();
    const lat = $('#lateral');                      // qualquer mudança feita no painel vira um passo do desfazer (se algo mudou de fato)
    const agenda = () => setTimeout(empilha, 0);
    lat.addEventListener('change', agenda); lat.addEventListener('click', agenda);
    $('#cDesf').addEventListener('click', desfaz); $('#cRef').addEventListener('click', refaz);
    ligaCamera($('#stage'));
    $('#cPainel').addEventListener('click', () => { M.painelMin = !M.painelMin; desenhaLateral(); });
    desenhaPalco(); desenhaLateral();
    if (M.ro) M.ro.disconnect();
    M.ro = new ResizeObserver(() => { const st = $('#stage'); if (!st || !st.clientWidth || st.classList.contains('stage-bare')) return; if (M.cam && M.cam.fit) enquadra(false); });
    M.ro.observe($('#stage'));
  }

  async function render(view, ctx) {
    M.view = view; M.ctx = ctx; M.cam = null; M.anim = true; M.frenteKey = null; M.metric = lsGet('mapaMetrica', 'risco'); M.vista = lsGet('mapaVista', innerWidth < 760 ? 'grade' : 'planta'); M.edit = false; M.draft = null; M.selCam = null; M.selPt = null; M.editG = false; M.draftG = null; M.draftDim = null; M.hist = null; M.previa = null; M.multi = [];
    view.innerHTML = `<div class="skeleton" style="height:480px;border-radius:18px"></div>`;
    const [data, cfg] = await Promise.all([api('/api/mapa'), api('/api/config')]);
    data.faixas = cfg.faixas; setAreas(data.areas);
    M.data = data;
    // layout antigo (caixas w/h fixas, sem escala): ganha a escala mediana e as caixas passam a ser derivadas das medidas em cm, mantendo o centro
    M.data.layout = Geom.migrarLayout(data.layout, id => geomG(id)).layout;
    if (M.sel !== null && !data.gondolas.some(g => g.id === M.sel)) M.sel = null;
    montaTudo();
    return data;
  }

  function selecionar(id) { M.sel = id; }
  return { render, selecionar };
})();
