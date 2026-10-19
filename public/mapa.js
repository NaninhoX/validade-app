'use strict';
// Mapa de calor da loja: planta (gôndolas) + detalhe por lado e prateleira. A planta é editável (arrastar/redimensionar) por administradores.
const Mapa = (() => {
  const M = { data: null, metric: 'risco', sel: null, shelf: null, edit: false, draft: null, view: null, ctx: null, ro: null };

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

  // ---------- planta ----------
  function layoutAtual() { return M.edit ? M.draft : M.data.layout; }

  function desenhaPalco() {
    const L = layoutAtual();
    const stage = $('#stage');
    if (!stage) return;
    const w = stage.clientWidth || 800;
    const s = w / L.largura;
    stage.style.height = (L.altura * s) + 'px';
    const porId = new Map(M.data.gondolas.map(g => [g.id, g]));
    const noLayout = new Set(L.gondolas.map(g => g.id));
    stage.innerHTML = `<div class="canvas" id="canvas" style="width:${L.largura}px;height:${L.altura}px;transform:scale(${s})">
      ${L.fundo ? `<div class="bg" style="background-image:url('${esc(L.fundo)}');opacity:${L.fundo_opacidade}"></div>` : ''}
      <div class="grid-bg"></div>
      ${L.gondolas.map((g, i) => {
        const d = porId.get(g.id), h = calor(d, false);
        const style = `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;--i:${i};${h.vazio ? '' : `--hc:${h.bg};--hi:${h.ink}`}`;
        const small = Math.min(g.w, g.h) < 40;
        return `<div class="gon${h.vazio ? ' vazia' : ''}${M.sel === g.id ? ' sel' : ''}${M.edit ? ' edit' : ''}" data-g="${g.id}" style="${style}" tabindex="0" role="button" aria-label="Gôndola ${g.id}">
          <div class="n" style="${small ? 'font-size:16px' : ''}">${g.id}</div>${small ? '' : `<div class="t">${h.vazio ? 'vazia' : esc(h.txt)}</div>`}
          ${d && d.vencidos ? `<span class="tag">${d.vencidos}</span>` : ''}${M.edit && M.sel === g.id ? '<span class="rz" data-rz="1"></span>' : ''}</div>`;
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
      el.addEventListener('click', () => { if (M.edit) { M.sel = id; desenhaPalco(); desenhaLateral(); } else { M.sel = id; M.shelf = null; desenhaPalco(); desenhaLateral(); } });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
      el.addEventListener('mousemove', e => {
        if (M.edit) return;
        const d = M.data.gondolas.find(g => g.id === id);
        tip.innerHTML = d ? `<b>Gôndola ${id}</b><br>${d.lotes} lotes · ${int(d.qtd)} itens<br>Valor ${brl(d.valor)}<br>${d.risco ? 'Em risco ' + brl(d.risco) + '<br>' : ''}Pior: ${esc(d.pior || '—')}${d.nunca_contada ? '<br>Nunca contada' : d.dias_sem_ronda !== null ? '<br>Ronda há ' + d.dias_sem_ronda + ' d' : ''}` : `<b>Gôndola ${id}</b><br>sem estoque`;
        tip.style.left = Math.min(innerWidth - 250, e.clientX + 16) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; tip.classList.add('on');
      });
      el.addEventListener('mouseleave', () => tip.classList.remove('on'));
      if (M.edit) arrasta(el, id, s);
    });
  }

  // arrastar / redimensionar (modo edição)
  function arrasta(el, id, s) {
    el.addEventListener('pointerdown', e => {
      const g = M.draft.gondolas.find(x => x.id === id);
      const rz = e.target.dataset.rz;
      if (M.sel !== id) { M.sel = id; desenhaLateral(); }
      const x0 = e.clientX, y0 = e.clientY, gx = g.x, gy = g.y, gw = g.w, gh = g.h;
      el.setPointerCapture(e.pointerId);
      const mover = ev => {
        const dx = (ev.clientX - x0) / s, dy = (ev.clientY - y0) / s;
        if (rz) { g.w = Math.max(30, Math.round((gw + dx) / 5) * 5); g.h = Math.max(30, Math.round((gh + dy) / 5) * 5); }
        else { g.x = Math.round((gx + dx) / 5) * 5; g.y = Math.round((gy + dy) / 5) * 5; }
        el.style.left = g.x + 'px'; el.style.top = g.y + 'px'; el.style.width = g.w + 'px'; el.style.height = g.h + 'px';
      };
      const fim = () => { el.removeEventListener('pointermove', mover); el.removeEventListener('pointerup', fim); desenhaPalco(); desenhaLateral(); };
      el.addEventListener('pointermove', mover); el.addEventListener('pointerup', fim);
      e.preventDefault();
    });
  }

  // ---------- painel lateral ----------
  function ordemNiveis() { return (layoutAtual().nivel_topo === 5 ? [5, 4, 3, 2, 1] : [1, 2, 3, 4, 5]); }

  function prateleira(g, chave, rotulo, i) {
    const c = g.celulas.find(x => x.chave === chave);
    const h = calor(c, true);
    const sel = M.shelf && M.shelf.g === g.id && M.shelf.chave === chave;
    if (!c) return `<div class="shelf vazia" style="--i:${i}"><span class="lv">${esc(rotulo)}</span><span class="nm">vazio</span><span></span></div>`;
    return `<button class="shelf${sel ? ' sel' : ''}" data-chave="${esc(chave)}" style="--i:${i};--hc:${h.bg};--hi:${h.ink}">
      <span class="lv">${esc(rotulo)}</span><span><span class="nm">${esc(c.pior)}</span><br><span class="vl">${c.lotes} lote${c.lotes > 1 ? 's' : ''} · ${int(c.qtd)} un</span></span><span class="vl">${esc(h.txt)}</span></button>`;
  }

  function lateralGondola() {
    const g = M.data.gondolas.find(x => x.id === M.sel) || { id: M.sel, lotes: 0, qtd: 0, valor: 0, risco: 0, celulas: [], vazia: true };
    const niv = ordemNiveis();
    const face = lado => `<div class="face"><h3><span>Lado ${lado} <span class="muted" style="font-weight:500">${lado === 'A' ? '(esquerda)' : '(direita)'}</span></span></h3>
      <div class="rack">${niv.map((n, i) => prateleira(g, `${lado}-${n}`, n, i)).join('')}</div></div>`;
    const pontas = ['F', 'C'].map(l => {
      const chaves = g.celulas.filter(c => c.lado === l).map(c => c.chave).sort();
      const lista = chaves.length ? chaves : [l];
      return `<div class="face"><h3><span>Ponta ${l === 'F' ? 'da frente (F)' : 'das costas (C)'}</span></h3><div class="rack">${lista.map((k, i) => prateleira(g, k, k === l ? 'ponta' : k.split('-')[1], i)).join('')}</div></div>`;
    }).join('');
    const geral = g.celulas.find(c => c.chave === 'geral');
    let itens = '';
    if (M.shelf && M.shelf.g === g.id) {
      const c = g.celulas.find(x => x.chave === M.shelf.chave);
      if (c) itens = `<div class="items"><div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0"><h3>${addr(enderecoDe(g.id, c.chave))} <span class="muted" style="font-weight:500">${c.itens.length} lote${c.itens.length > 1 ? 's' : ''}</span></h3>
        <a href="#/estoque?q=${encodeURIComponent(enderecoDe(g.id, c.chave))}" class="small">Ver no estoque →</a></div>
        ${c.itens.map(it => `<div class="item"><span class="dot" style="--c:${esc(it.cor)}"></span><div style="min-width:0"><div class="pname" style="font-size:13px">${esc(it.nome || it.ean)}</div><div class="xs muted">lote ${esc(it.lote)} · vence ${brData(it.validade)} (${it.dias}d)${it.desconto ? ' · oferta ' + it.desconto + '%' : ''}</div></div><div style="text-align:right">${pill(it.status, it.cor)}<div class="xs muted" style="margin-top:3px">${it.qtd} un</div></div></div>`).join('')}</div>`;
    }
    return `<div class="card drawer">
      <div class="head" style="margin-bottom:10px"><div><h2 style="font-size:20px">Gôndola ${g.id}</h2><div class="sub">${g.lotes ? `${g.lotes} lotes · ${int(g.qtd)} itens · ${brl(g.valor)}` : 'sem estoque cadastrado'}</div></div>
        <button class="icon subtle" id="fecha" aria-label="Fechar">${ico('x')}</button></div>
      ${g.risco ? `<div class="callout warn" style="margin-bottom:12px">${ico('flame')}<div><b>${brl(g.risco)}</b> em risco${g.vencidos ? ` · <b>${g.vencidos}</b> vencido${g.vencidos > 1 ? 's' : ''}` : ''}${g.nunca_contada ? ' · endereços ainda sem contagem' : g.dias_sem_ronda > 7 ? ` · ronda há ${g.dias_sem_ronda} dias` : ''}</div></div>` : ''}
      <div class="faces">${face('A')}${face('B')}</div>
      <div class="faces" style="margin-top:12px">${pontas}</div>
      ${geral ? `<div style="margin-top:12px"><h3 style="margin-bottom:6px">Sem prateleira definida</h3><div class="rack">${prateleira(g, 'geral', '?', 0)}</div><p class="xs muted" style="margin-top:6px">Esses lotes estão só com o número da gôndola. Na próxima ronda, informe lado e prateleira (ex.: ${g.id}-A-1).</p></div>` : ''}
      ${itens}</div>`;
  }

  function lateralEdicao() {
    const L = M.draft, g = L.gondolas.find(x => x.id === M.sel);
    const livres = Array.from({ length: 19 }, (_, i) => i + 1).filter(n => !L.gondolas.some(x => x.id === n));
    return `<div class="card drawer"><div class="head"><div><h2>Editar planta</h2><div class="sub">Arraste as gôndolas; puxe a bolinha azul para redimensionar.</div></div></div>
      <div class="grid" style="gap:14px">
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label class="f">Largura da planta</label><input id="eLarg" type="number" min="400" max="4000" step="50" value="${L.largura}"></div>
          <div><label class="f">Altura da planta</label><input id="eAlt" type="number" min="300" max="4000" step="50" value="${L.altura}"></div></div>
        <div><label class="f">Numeração das prateleiras</label><div class="seg"><button data-topo="1" aria-pressed="${L.nivel_topo !== 5}">1 no topo</button><button data-topo="5" aria-pressed="${L.nivel_topo === 5}">1 embaixo</button></div></div>
        <div><label class="f">Planta da loja (imagem de fundo)</label>
          <div class="editbar"><label class="btn sm" style="cursor:pointer">${ico('image')} Enviar imagem<input id="eFundo" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${L.fundo ? `<button class="sm danger" id="eSemFundo">Remover</button>` : ''}</div>
          ${L.fundo ? `<label class="f" style="margin-top:10px">Transparência da imagem</label><input id="eOp" type="range" min="0" max="1" step="0.05" value="${L.fundo_opacidade}" style="min-height:24px;padding:0">` : ''}</div>
        <div><label class="f">Gôndola selecionada</label>${g ? `<div class="editbar"><b style="font-size:18px">${g.id}</b><button class="sm" id="eGira">${ico('rotate')} Girar</button><button class="sm danger" id="eRemove">${ico('minus')} Tirar da planta</button></div>` : '<p class="small muted">Clique numa gôndola para selecionar.</p>'}</div>
        ${livres.length ? `<div><label class="f">Adicionar gôndola</label><div class="editbar">${livres.map(n => `<button class="sm" data-add="${n}">${n}</button>`).join('')}</div></div>` : ''}
        <div class="editbar" style="justify-content:flex-end"><button id="eCancela">Cancelar</button><button class="primary" id="eSalva">${ico('check')} Salvar planta</button></div>
      </div></div>`;
  }

  function desenhaLateral() {
    const el = $('#lateral');
    if (!el) return;
    if (M.edit) { el.innerHTML = lateralEdicao(); ligaEdicao(); return; }
    if (M.sel === null) {
      const top = [...M.data.gondolas].sort((a, b) => b.risco - a.risco).slice(0, 6);
      const sl = M.data.sem_local;
      el.innerHTML = `<div class="card drawer"><div class="head"><div><h2>Selecione uma gôndola</h2><div class="sub">Clique na planta para ver lados A/B, pontas e cada prateleira.</div></div></div>
        <h3 style="margin:4px 0 6px">Onde está o maior risco</h3>
        ${top.length ? top.map(g => `<div class="row click" data-g="${g.id}"><span class="dot" style="--c:${esc(g.cor || '#94a3b8')}"></span><div><div class="pname">Gôndola ${g.id}</div><div class="xs muted">${g.lotes} lotes · ${g.vencidos} vencidos</div></div><b class="num">${brlK(g.risco)}</b></div>`).join('') : '<p class="muted small">Sem estoque mapeado.</p>'}
        ${sl.lotes ? `<div class="callout warn" style="margin-top:14px">${ico('alert')}<div><b>${sl.lotes} lotes</b> sem endereço válido (${sl.enderecos.map(e => esc(e.endereco)).join(', ')}). Ajuste na próxima ronda.</div></div>` : ''}</div>`;
      $$('.row[data-g]', el).forEach(r => r.addEventListener('click', () => { M.sel = +r.dataset.g; desenhaPalco(); desenhaLateral(); }));
      return;
    }
    el.innerHTML = lateralGondola();
    $('#fecha', el).addEventListener('click', () => { M.sel = null; M.shelf = null; desenhaPalco(); desenhaLateral(); });
    $$('.shelf[data-chave]', el).forEach(b => b.addEventListener('click', () => { M.shelf = { g: M.sel, chave: b.dataset.chave }; desenhaLateral(); }));
  }

  function ligaEdicao() {
    const L = M.draft;
    $$('[data-topo]').forEach(b => b.addEventListener('click', () => { L.nivel_topo = +b.dataset.topo; desenhaLateral(); }));
    $('#eLarg').addEventListener('change', e => { L.largura = +e.target.value; desenhaPalco(); });
    $('#eAlt').addEventListener('change', e => { L.altura = +e.target.value; desenhaPalco(); });
    const op = $('#eOp'); if (op) op.addEventListener('input', e => { L.fundo_opacidade = +e.target.value; const bg = $('#canvas .bg'); if (bg) bg.style.opacity = L.fundo_opacidade; });
    const sf = $('#eSemFundo'); if (sf) sf.addEventListener('click', () => { L.fundo = null; desenhaPalco(); desenhaLateral(); });
    $('#eFundo').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { L.fundo = await reduzImagem(f); desenhaPalco(); desenhaLateral(); } catch (er) { toast(er.message, 'bad'); }
    });
    const gi = $('#eGira'); if (gi) gi.addEventListener('click', () => { const g = L.gondolas.find(x => x.id === M.sel); [g.w, g.h] = [g.h, g.w]; g.rot = g.rot ? 0 : 90; desenhaPalco(); });
    const rm = $('#eRemove'); if (rm) rm.addEventListener('click', () => { L.gondolas = L.gondolas.filter(x => x.id !== M.sel); M.sel = null; desenhaPalco(); desenhaLateral(); });
    $$('[data-add]').forEach(b => b.addEventListener('click', () => { const id = +b.dataset.add; L.gondolas.push({ id, x: 60 + (id % 5) * 40, y: 60, w: 150, h: 46, rot: 0 }); M.sel = id; desenhaPalco(); desenhaLateral(); }));
    $('#eCancela').addEventListener('click', () => { M.edit = false; M.draft = null; M.sel = null; montaTudo(); });
    $('#eSalva').addEventListener('click', async () => {
      try { M.data.layout = await api('/api/layout', { method: 'PUT', body: M.draft }); M.edit = false; M.draft = null; toast('Planta salva', 'ok'); montaTudo(); }
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
        <div class="editbar">${legenda()}${M.ctx.admin && !M.edit ? `<button id="editar">${ico('edit')} Editar planta</button>` : ''}</div>
      </div>
      ${L.provisorio && !M.edit ? `<div class="callout reveal" style="--i:1;margin-bottom:16px">${ico('info')}<div><b>Planta provisória.</b> As 19 gôndolas estão em grade só para você já enxergar os dados. ${M.ctx.admin ? 'Clique em <b>Editar planta</b> para arrastar cada gôndola até a posição real e enviar a imagem do layout da loja como fundo.' : 'Peça a um administrador para montar a planta real.'}</div></div>` : ''}
      <div id="orfas" style="margin-bottom:16px"></div>
      <div class="mapa-wrap"><div class="stage reveal" style="--i:2" id="stage"></div><div id="lateral"></div></div>
      <div class="tip" id="tip"></div>`;
    $$('[data-metric]', v).forEach(b => b.addEventListener('click', () => { M.metric = b.dataset.metric; lsSet('mapaMetrica', M.metric); montaTudo(); }));
    const ed = $('#editar', v);
    if (ed) ed.addEventListener('click', () => { M.edit = true; M.draft = JSON.parse(JSON.stringify(M.data.layout)); M.sel = null; M.shelf = null; montaTudo(); });
    desenhaPalco(); desenhaLateral();
    if (M.ro) M.ro.disconnect();
    M.ro = new ResizeObserver(() => { const s = $('#stage'); if (s && s.clientWidth) { const L2 = layoutAtual(), k = s.clientWidth / L2.largura, c = $('#canvas'); if (c) { c.style.transform = `scale(${k})`; s.style.height = L2.altura * k + 'px'; } } });
    M.ro.observe($('#stage'));
  }

  async function render(view, ctx) {
    M.view = view; M.ctx = ctx; M.metric = lsGet('mapaMetrica', 'risco'); M.edit = false; M.draft = null;
    view.innerHTML = `<div class="skeleton" style="height:480px;border-radius:18px"></div>`;
    const [data, cfg] = await Promise.all([api('/api/mapa'), api('/api/config')]);
    data.faixas = cfg.faixas;
    M.data = data;
    if (M.sel !== null && !data.gondolas.some(g => g.id === M.sel)) M.sel = null;
    montaTudo();
    return data;
  }

  function selecionar(id) { M.sel = id; }
  return { render, selecionar };
})();
