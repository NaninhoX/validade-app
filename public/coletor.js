'use strict';
// Coletor: aba do app (entrada, ronda, baixa, busca) + fila de envio offline compartilhada com o topo do app.
const Fila = (() => {
  const ler = () => lsGet('fila', []);
  const rejeitados = () => lsGet('rejeitados', []);
  let enviando = false;

  function atualiza() {
    const n = ler().length, p = $('#sync'), t = $('#syncTxt');
    if (p) {
      p.className = 'sync' + (!navigator.onLine ? ' off' : n ? ' pend' : '');
      t.textContent = !navigator.onLine ? `Offline${n ? ' · ' + n : ''}` : n ? `Enviando ${n}…` : 'Online';
    }
    const rej = rejeitados(), box = $('#rejeitados');
    if (box) {
      box.hidden = !rej.length;
      box.innerHTML = rej.length ? `<b>${rej.length} lançamento(s) recusado(s)</b>` + rej.map((r, i) => `<div style="margin-top:8px">${esc(r.body.ean || r.body.lote_id)} — ${esc(r.erro)} <button class="sm" data-i="${i}">descartar</button></div>`).join('') : '';
    }
  }

  async function enviar() {
    if (enviando) return;
    enviando = true;
    try {
      for (;;) {
        const f = ler();
        if (!f.length) break;
        try {
          const r = await api('/api/leituras', { method: 'POST', body: f[0], tentativas: 0 });
          lsSet('fila', ler().slice(1));
          if (r.avisos?.length) toast(r.avisos.join(' · '));
        } catch (e) {
          if (e.status) { const rej = rejeitados(); rej.push({ body: f[0], erro: e.message }); lsSet('rejeitados', rej); lsSet('fila', ler().slice(1)); }
          else break; // sem rede: tenta depois
        }
      }
    } finally { enviando = false; atualiza(); }
  }

  function inicia() {
    window.addEventListener('online', enviar);
    window.addEventListener('offline', atualiza);
    setInterval(enviar, 10000);
    $('#sync').addEventListener('click', () => { enviar(); toast(ler().length ? `${ler().length} lançamento(s) aguardando envio` : 'Tudo sincronizado', 'ok', 2200); });
    atualiza(); enviar();
  }

  return { ler, rejeitados, atualiza, enviar, inicia };
})();

const Coletor = (() => {
  let modo = 'entrada', tipoEntrada = 'RECEBIMENTO', produtoAtual = null;
  let rondaItens = [], rondaFeitos = new Set(), bipados = new Set(), rondaEnd = '', rondaTs = 0, rondaChave = '';
  let turno = lsGet('turno', null), emTurno = -1;      // ronda do dia (guardada no aparelho até o fim do dia)
  let VALMIN = 0, MINHAS = [];       // validade mínima no recebimento; setores (gôndola-lado) sob responsabilidade de quem está logado
  let CFG = null, ultimo = null, ultimoLote = null, ultimoTally = null, undoTimer, ac;
  const enter = {};

  const nome = () => (typeof S !== 'undefined' && S.op) || 'COLETOR';

  // ---------- som / vibração ----------
  function beep(ok = true) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(ac.destination);
      g.gain.value = 0.08; o.start(); o.stop(ac.currentTime + (ok ? 0.08 : 0.3));
    } catch { /* sem áudio */ }
    if (!ok && navigator.vibrate) navigator.vibrate(200);
  }

  async function lancar(body) {
    body = { client_id: uuid(), operador: nome(), ts: new Date().toISOString(), ...body };
    try {
      const r = await api('/api/leituras', { method: 'POST', body, tentativas: 0 });
      beep(true);
      return r;
    } catch (e) {
      if (e.status) { beep(false); throw e; }
      lsSet('fila', [...Fila.ler(), body]);
      Fila.atualiza(); beep(true);
      return { fila: true, avisos: [] };
    }
  }

  function aoEnter(id, fn) { enter[id] = fn; $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }); }

  async function carregaEnderecos() {
    let l = lsGet('enderecos', []);
    try { l = (await api('/api/enderecos')).map(e => e.endereco).filter(Boolean); lsSet('enderecos', l); } catch { /* cache */ }
    const dl = $('#listaEnd'); if (dl) dl.innerHTML = l.map(e => `<option value="${esc(e)}">`).join('');
  }

  // ---------- HTML ----------
  function html() {
    return `<div class="cwrap">
  <div class="seg cmodes" role="group" aria-label="Modo do coletor">
    <button data-modo="entrada" aria-pressed="true">Entrada</button><button data-modo="ronda" aria-pressed="false">Ronda</button>
    <button data-modo="baixa" aria-pressed="false">Baixa</button><button data-modo="busca" aria-pressed="false">Buscar</button>
  </div>

  <section id="m-entrada">
    <div class="seg" style="width:100%;margin-bottom:16px" role="group" aria-label="Tipo de entrada">
      <button id="tReceber" aria-pressed="true" style="flex:1;min-height:40px">Receber (soma)</button>
      <button id="tContar" aria-pressed="false" style="flex:1;min-height:40px">Contar (define)</button>
    </div>
    <div class="f-wrap"><label class="f" for="end"><span class="step">1</span>Endereço</label>
      <div class="in"><input id="end" list="listaEnd" autocomplete="off" autocapitalize="characters" placeholder="ex.: 1-B-3"><button class="cam" data-cam="end" aria-label="Ler etiqueta do endereço">${ico('camera', 24)}</button></div><datalist id="listaEnd"></datalist>
      <div id="endChips" aria-label="Atalhos de endereço" style="display:grid;gap:8px;margin-top:10px"></div>
      <div class="xs muted" id="endDesc" style="margin-top:8px;min-height:18px"></div></div>
    <div class="f-wrap"><label class="f" for="ean"><span class="step">2</span>Código de barras (EAN)</label>
      <div class="in"><input id="ean" inputmode="numeric" autocomplete="off" placeholder="bipe ou use a câmera"><button class="cam" data-cam="ean" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div></div>
    <div id="prod" class="prod" hidden></div>
    <div id="cadRapido" hidden>
      <div class="f-wrap"><label class="f" for="cNome">Produto novo — nome</label><input id="cNome" autocomplete="off"></div>
      <div class="f-wrap"><label class="f" for="cPreco">Preço (opcional)</label><input id="cPreco" inputmode="decimal" autocomplete="off"></div>
    </div>
    <div class="f-wrap" id="precoWrap" hidden><label class="f" for="pPreco">Preço de venda <span class="muted">(este produto ainda não tem preço)</span></label>
      <input id="pPreco" inputmode="decimal" autocomplete="off" placeholder="ex.: 39,90"></div>
    <div class="f-wrap"><label class="f" for="lote"><span class="step">3</span>Lote</label><input id="lote" autocomplete="off" autocapitalize="characters"></div>
    <div class="f-wrap"><label class="f" for="val"><span class="step">4</span>Validade (DDMMAA, DD/MM/AAAA ou MM/AA)</label><input id="val" inputmode="numeric" autocomplete="off" placeholder="ex.: 150327"></div>
    <div class="prev" id="prev" aria-live="polite"></div>
    <div class="f-wrap"><label class="f" for="qtd"><span class="step">5</span>Quantidade</label><input id="qtd" inputmode="numeric" autocomplete="off"></div>
    <div id="avisos"></div>
    <button id="salvar" class="primary big">Salvar</button>
  </section>

  <section id="m-ronda" hidden>
    <div id="rDia"></div>
    <div id="rEscolha" hidden>
      <button id="rVoltaDia" class="sm" style="margin-bottom:12px">${ico('chevron')} Ronda do dia</button>
      <div class="f-wrap"><label class="f" for="rEnd">Endereço da ronda</label>
        <div class="in"><input id="rEnd" list="listaEnd" autocomplete="off" autocapitalize="characters" placeholder="bipe a etiqueta ou digite (1-B-3)"><button class="cam" data-cam="rEnd" aria-label="Ler etiqueta do endereço">${ico('camera', 24)}</button></div></div>
      <button id="rCarregar" class="big primary">Carregar endereço</button>
    </div>
    <div id="rCorpo" hidden>
      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:6px">
        <button id="rTrocar" class="sm">${ico('chevron')} <span id="rTrocarTxt">Trocar endereço</span></button><span class="small muted" id="rConta"></span>
      </div>
      <div id="rInfo" class="muted small"></div>
      <div class="prog" id="rProg"><i></i></div>
      <div class="f-wrap"><label class="f" for="rBusca">Bipe um produto para localizá-lo na lista</label>
        <div class="in"><input id="rBusca" inputmode="numeric" autocomplete="off"><button class="cam" data-cam="rBusca" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div></div>
      <div id="rLista"></div>
      <button id="rNovo" class="big">＋ Item que não estava na lista</button>
      <div id="rFim" class="rfim" hidden>
        <button id="rPular" class="big">Pular</button>
        <button id="rConcluir" class="big primary">Concluir endereço</button>
      </div>
    </div>
  </section>

  <section id="m-baixa" hidden>
    <div class="f-wrap"><label class="f" for="bEan">Código de barras (EAN)</label>
      <div class="in"><input id="bEan" inputmode="numeric" autocomplete="off" placeholder="bipe ou use a câmera"><button class="cam" data-cam="bEan" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div></div>
    <div id="bLista"></div>
  </section>

  <section id="m-busca" hidden>
    <div class="f-wrap"><label class="f" for="sEan">EAN ou parte do nome</label>
      <div class="in"><input id="sEan" autocomplete="off" placeholder="onde está esse produto?"><button class="cam" data-cam="sEan" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div></div>
    <div id="sLista"></div>
  </section>

  <div id="rejeitados" class="rej" hidden></div>
  <div class="undo" id="undo" hidden><span id="undoTxt"></span><button id="undoBtn">Desfazer</button></div>
</div>`;
  }

  // ---------- modos ----------
  function setModo(m, foco = true) {
    modo = m; lsSet('coletorModo', m);
    $$('.cmodes button').forEach(b => b.setAttribute('aria-pressed', b.dataset.modo === m));
    ['entrada', 'ronda', 'baixa', 'busca'].forEach(x => { $('#m-' + x).hidden = x !== m; });
    if (m === 'ronda' && !$('#rDia').hidden) desenhaDia();
    if (!foco || matchMedia('(pointer: coarse)').matches) return;   // no celular não abre o teclado sozinho
    ({ entrada: () => ($('#end').value ? $('#ean') : $('#end')), ronda: () => $('#rEnd'), baixa: () => $('#bEan'), busca: () => $('#sEan') }[m]()).focus({ preventScroll: true });
  }

  function mostraUndo(grupo, txt, loteId = null, tally = null) {
    ultimo = grupo; ultimoLote = loteId; ultimoTally = tally;
    if (!grupo) return;
    $('#undoTxt').textContent = txt; $('#undo').hidden = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { const u = $('#undo'); if (u) u.hidden = true; }, 45000);
  }

  // ---------- endereço ----------
  const partes = v => { const m = String(v || '').trim().toUpperCase().match(/^(\d{1,2})(?:-(A|B|F|C|PE|PD))?(?:-(\d))?$/); return m ? { g: m[1], lado: m[2] || null, nivel: m[3] ? +m[3] : null } : null; };
  function atualizaEnd() {
    const v = $('#end').value, p = parseEndereco(v), q = partes(v);
    $('#endDesc').innerHTML = !v.trim() ? 'Gôndola-lado-prateleira. Ex.: 1-B-3 (lado B, prateleira 3) · 1-F ou 1-C = ponta'
      : p.valido ? `<span style="color:var(--good)">✓</span> ${esc(descEndereco(v))}` : q ? `Falta o lado (${ladosDe(q.g).join(', ')}) e a prateleira (1 a 5)` : '<span style="color:var(--bad)">Endereço fora do padrão</span>';
    const linha = (rot, itens) => `<div class="chips" style="margin:0;width:100%;align-items:center"><span class="small muted" style="width:72px">${rot}</span>${itens}</div>`;
    $('#endChips').innerHTML =
      linha('Lado', ladosDe(q?.g).map(l => `<button class="chip sq" data-lado="${l}" aria-pressed="${q?.lado === l}" title="${LADO_TXT[l]}">${l}</button>`).join('')) +
      linha('Prateleira', [1, 2, 3, 4, 5].map(n => `<button class="chip sq" data-nivel="${n}" aria-pressed="${q?.nivel === n}">${n}</button>`).join(''));
    lsSet('ultimoEnd', v);
  }

  // ---------- entrada ----------
  function setTipo(t) { tipoEntrada = t; $('#tReceber').setAttribute('aria-pressed', t === 'RECEBIMENTO'); $('#tContar').setAttribute('aria-pressed', t === 'CONTAGEM'); }

  async function buscaProdutoEntrada() {
    const ean = $('#ean').value.trim();
    if (!ean) return;
    produtoAtual = null;
    $('#prod').hidden = true; $('#cadRapido').hidden = true; $('#precoWrap').hidden = true;
    try { produtoAtual = await api('/api/produto/' + encodeURIComponent(ean.replace(/\D/g, ''))); }
    catch (e) { if (e.status) { toast(e.message, 'bad'); return; } produtoAtual = { offline: true, cadastrado: true, lotes: [] }; }
    const box = $('#prod');
    if (produtoAtual.offline) {
      box.hidden = false; box.innerHTML = '<b>Sem conexão</b><span class="muted small">O lançamento será enviado quando a rede voltar.</span>';
    } else if (!produtoAtual.cadastrado) {
      beep(false);
      $('#cadRapido').hidden = false; $('#cNome').focus();
      box.hidden = false; box.innerHTML = '<b>EAN não cadastrado</b><span class="muted small">Informe o nome para cadastrar agora.</span>';
      return;
    } else {
      const p = produtoAtual.produto;
      box.hidden = false;
      box.innerHTML = `<b>${esc(p.nome)}</b><span class="muted small">${p.preco ? brl(p.preco) : 'sem preço'}${p.marca ? ' · ' + esc(p.marca) : ''}</span>` +
        (produtoAtual.lotes.length ? `<div class="chips">${produtoAtual.lotes.map(l => `<button class="lotechip" data-lote="${esc(l.lote)}" data-val="${l.validade}" data-end="${esc(l.endereco)}">${esc(l.lote)} · ${brData(l.validade)} · ${l.qtd}un · ${esc(l.endereco || 'sem end.')}</button>`).join('')}</div>` : '<span class="muted small">Nenhum lote em estoque.</span>');
      if (!p.preco) { $('#precoWrap').hidden = false; $('#pPreco').focus(); return; }
    }
    $('#lote').focus();
  }

  function previaValidade() {
    const v = $('#val').value.trim(), el = $('#prev');
    if (!v) { el.textContent = ''; return null; }
    const iso = parseData(v);
    if (!iso) { el.innerHTML = '<span style="color:var(--bad)">data inválida</span>'; return null; }
    const d = diasAte(iso);
    const cor = d <= 0 ? 'var(--bad)' : d <= 30 ? '#f97316' : d <= 90 ? 'var(--warn)' : 'var(--good)';
    el.innerHTML = `<b style="color:${cor}">${brData(iso)}</b> · ${d < 0 ? 'vencido há ' + (-d) + ' dias' : d === 0 ? 'vence hoje' : 'em ' + d + ' dias'}`
      + (tipoEntrada === 'RECEBIMENTO' && VALMIN && d > 0 && d < VALMIN ? ` · <span style="color:var(--warn)">abaixo do mínimo de ${VALMIN} dias para receber — confira com o CD</span>` : '');
    return iso;
  }

  async function salvarEntrada() {
    const ean = $('#ean').value.replace(/\D/g, ''), endereco = $('#end').value.trim().toUpperCase();
    const validade = previaValidade(), qtd = $('#qtd').value.trim();
    if (!parseEndereco(endereco).valido) { toast('Endereço fora do padrão (ex.: 1-B-3)', 'bad'); beep(false); return $('#end').focus(); }
    if (!ean) { toast('Bipe o produto', 'bad'); beep(false); return $('#ean').focus(); }
    if (!validade) { toast('Validade inválida', 'bad'); beep(false); return $('#val').focus(); }
    if (!/^\d+$/.test(qtd) || (tipoEntrada === 'RECEBIMENTO' && +qtd < 1)) { toast('Quantidade inválida', 'bad'); beep(false); return $('#qtd').focus(); }
    const body = { tipo: tipoEntrada, ean, lote: $('#lote').value, validade, endereco, qtd: +qtd };
    if (produtoAtual && !produtoAtual.cadastrado && !produtoAtual.offline) {
      if (!$('#cNome').value.trim()) { toast('Informe o nome do produto novo', 'bad'); beep(false); return $('#cNome').focus(); }
      body.nome = $('#cNome').value.trim(); body.preco = $('#cPreco').value.replace(',', '.');
    }
    const pp = $('#pPreco').value.trim();
    if (!$('#precoWrap').hidden && pp) {
      if (!/^d+([.,]d{1,2})?$/.test(pp)) { toast('Preço inválido (ex.: 39,90)', 'bad'); beep(false); return $('#pPreco').focus(); }
      body.preco = pp.replace(',', '.');
    }
    $('#salvar').disabled = true;
    try {
      const r = await lancar(body);
      const nomeProd = produtoAtual?.produto?.nome || body.nome || ean;
      $('#avisos').innerHTML = (r.avisos || []).map(a => `<div class="aviso">${ico('alert')}<span>${esc(a)}</span></div>`).join('');
      if (r.avisos?.length) beep(false);
      toast(r.fila ? 'Guardado — será enviado quando a rede voltar' : `${tipoEntrada === 'RECEBIMENTO' ? '+' : '='}${qtd} ${nomeProd}`, r.fila ? '' : 'ok', 2500);
      if (r.grupo) mostraUndo(r.grupo, `${tipoEntrada === 'RECEBIMENTO' ? 'Recebido' : 'Contado'}: ${qtd} × ${nomeProd}`);
      ['ean', 'lote', 'val', 'qtd', 'cNome', 'cPreco', 'pPreco'].forEach(id => { $('#' + id).value = ''; });
      $('#prev').textContent = ''; $('#prod').hidden = true; $('#cadRapido').hidden = true; $('#precoWrap').hidden = true; produtoAtual = null;
      $('#ean').focus();
      carregaEnderecos();
    } catch (e) { toast(e.message, 'bad', 5000); }
    finally { const b = $('#salvar'); if (b) b.disabled = false; }
  }

  // ---------- ronda ----------
  const hojeLocal = () => new Date().toLocaleDateString('en-CA');
  const kEan = x => String(x || '').replace(/\D/g, '').replace(/^0+/, '');
  const exigeBip = it => it.dias <= 30;           // vencendo em até 30 dias só confirma com o código lido
  const salvaTurno = () => lsSet('turno', turno);
  const conta = k => { if (turno && emTurno >= 0 && !turno.fim) { turno.tally[k] = (turno.tally[k] || 0) + 1; salvaTurno(); } };
  const novoTally = () => ({ conf: 0, fix: 0, zero: 0, ret: 0, etq: 0, mov: 0, semBip: 0 });

  function mostraRonda(tela) {
    $('#rDia').hidden = tela !== 'dia'; $('#rEscolha').hidden = tela !== 'escolha'; $('#rCorpo').hidden = tela !== 'corpo';
    if (tela === 'dia') desenhaDia();
  }

  async function gerarTurno() {
    const n = +lsGet('rondaN', 10);
    const b = $('#rGerar'); if (b) b.disabled = true;
    try {
      const minhas = MINHAS.length && lsGet('rondaMinhas', true);
      const r = await api('/api/ronda?n=' + n + (minhas ? '&setores=' + MINHAS.join(',') : ''));
      if (!r.enderecos.length) { toast('Nada para conferir hoje — todos os endereços já foram vistos', 'ok', 4000); return; }
      turno = { dia: hojeLocal(), n: r.enderecos.length, criado: Date.now(), fim: null, cobertura: r.cobertura, setores: r.setores || {}, minhas: !!minhas,
        itens: r.enderecos.map(e => ({ e: e.endereco, g: e.gondola, lotes: e.lotes, venc: e.vencidos, urg: e.urgentes, etq: e.etiquetar, dias: e.dias_sem, ok: e.valido, feito: false, pulou: false })),
        tally: novoTally() };
      salvaTurno(); emTurno = -1; desenhaDia();
    } catch (e) { toast(e.status ? e.message : 'Sem conexão para montar a ronda', 'bad', 4000); }
    finally { const x = $('#rGerar'); if (x) x.disabled = false; }
  }

  async function carregaMinhas() {
    try {
      const r = await api('/api/setores');
      MINHAS = Object.entries(r).flatMap(([g, lados]) => Object.entries(lados).filter(([, s]) => s.resp.includes(nome())).map(([l]) => `${g}-${l}`));
    } catch { /* sem rede: segue sem filtro */ }
    const box = $('#rFiltro'); if (!box) return;
    const so = lsGet('rondaMinhas', true);
    box.innerHTML = MINHAS.length ? `<div class="f" style="margin-top:14px">Quais setores?</div><div class="chips" style="margin-top:6px">
      <button class="chip" data-minhas="1" aria-pressed="${so}">Só os meus (${MINHAS.join(', ')})</button><button class="chip" data-minhas="0" aria-pressed="${!so}">Todas</button></div>` : '';
  }

  async function painelSemana() {
    const box = $('#rPainel'); if (!box) return;
    try {
      const p = await api('/api/ronda/painel?dias=7');
      if (!$('#rPainel')) return;
      box.innerHTML = p.length ? `<div class="rd-painel"><div class="rp-h"><span>Últimos 7 dias</span><span>Endereços</span><span>Itens</span><span>Divergência</span></div>` +
        p.slice(0, 7).map(d => `<div><span>${esc(brData(d.dia).slice(0, 5))}</span><span>${d.enderecos}</span><span>${d.lotes}</span><span>${d.divergencia === null ? '—' : d.divergencia.toLocaleString('pt-BR') + '%'}</span></div>`).join('') + '</div>'
        : '<p class="small muted">Ainda não há rondas registradas. Divergência = itens que não bateram com o sistema.</p>';
    } catch { box.innerHTML = ''; }
  }

  function chipsEnd(t) {
    const c = [`<span class="rc">${t.lotes} lote${t.lotes > 1 ? "s" : ""}</span>`];
    if (t.venc) c.push(`<span class="rc bad">${t.venc} vencido${t.venc > 1 ? 's' : ''}</span>`);
    if (t.urg) c.push(`<span class="rc warn">${t.urg} vence${t.urg > 1 ? 'm' : ''} em até 30 d</span>`);
    for (const [p, q] of Object.entries(t.etq || {}).sort((a, b) => b[0] - a[0])) c.push(`<span class="rc tag">${q} p/ etiquetar ${p}%</span>`);
    c.push(`<span class="rc">${t.dias === null ? 'nunca conferido' : 'conferido há ' + t.dias + ' d'}</span>`);
    if (!t.ok) c.push('<span class="rc warn">fora do padrão</span>');
    return c.join('');
  }

  // nome e responsáveis do setor (lado) deste endereço
  function setorTxt(t) {
    const p = parseEndereco(t.e), s = ((turno.setores || {})[p.gondola] || {})[p.lado];
    return s ? ' · ' + esc([s.nome, s.resp.map(n => n.charAt(0) + n.slice(1).toLowerCase()).join(', ')].filter(Boolean).join(' — ')) : '';
  }

  function desenhaDia() {
    const box = $('#rDia'); if (!box) return;
    if (turno && turno.dia !== hojeLocal() && !turno.fim) { turno = null; salvaTurno(); }
    if (!turno) {
      const n = +lsGet('rondaN', 10);
      box.innerHTML = `<div class="rd-start">
        <h2>Ronda do dia</h2>
        <p class="muted">O app escolhe os endereços onde há mais a perder ou mais tempo sem conferir, já na ordem de caminhada.</p>
        <div class="f" style="margin-top:14px">Quantos endereços hoje?</div>
        <div class="chips" id="rTam" style="margin-top:6px">${[5, 10, 20].map(x => `<button class="chip" data-n="${x}" aria-pressed="${x === n}">${x}</button>`).join('')}</div>
        <div id="rFiltro"></div>
        <button id="rGerar" class="big primary" style="margin-top:16px">Gerar ronda de hoje</button>
        <div id="rPainel" style="margin-top:18px"></div>
        <button id="rManual" class="sm" style="margin-top:14px">Conferir um endereço específico</button></div>`;
      painelSemana(); carregaMinhas();
      return;
    }
    if (turno.fim) { box.innerHTML = resumoTurno(); return; }
    const feitos = turno.itens.filter(i => i.feito).length;
    const prox = turno.itens.findIndex(i => !i.feito && !i.pulou);
    let g = null;
    const cartoes = turno.itens.map((t, k) => {
      const cab = t.g !== g ? `<div class="rd-g">${t.g >= 99 ? 'Sem gôndola' : 'Gôndola ' + t.g}</div>` : '';
      g = t.g;
      return cab + `<button class="alvo ${t.feito ? 'feito' : ''} ${k === prox ? 'prox' : ''}" data-i="${k}" id="al-${k}">
        <span class="aend">${esc(t.e)}</span><span class="adesc">${esc(descEndereco(t.e)) || ''}${setorTxt(t)}${t.pulou && !t.feito ? ' · pulado' : ''}</span>
        <span class="achips">${t.feito ? '<span class="rc ok">conferido</span>' : chipsEnd(t)}</span>
        <span class="ach">${t.feito ? ico('check') : ico('chevron')}</span></button>`;
    }).join('');
    box.innerHTML = `<div class="rd-head"><b>${feitos} de ${turno.n} endereços</b><span class="muted small">cobre ${turno.cobertura.toLocaleString('pt-BR')}% do valor em risco${turno.minhas ? ' das suas gôndolas' : ''}</span></div>
      <div class="prog"><i style="width:${turno.n ? feitos / turno.n * 100 : 0}%"></i></div>
      ${cartoes}
      <div class="rd-foot">${feitos === turno.n ? '<button id="rEncerrar" class="big primary">Ver resultado da ronda</button>' : '<button id="rEncerrar" class="sm">Encerrar ronda agora</button>'}</div>`;
    const alvo = $('#al-' + prox); if (alvo && feitos) alvo.scrollIntoView({ block: 'center' });
  }

  function resumoTurno() {
    const t = turno.tally, itens = t.conf + t.fix + t.zero, div = itens ? (t.fix + t.zero) / itens * 100 : 0;
    const feitos = turno.itens.filter(i => i.feito).length;
    const min = Math.max(1, Math.round((turno.fim - turno.criado) / 60000));
    const leitura = itens < 10 ? '' : div < 10 ? 'O sistema está bem calibrado: quase tudo bateu com a prateleira.'
      : div > 40 ? 'Muita coisa não bateu: a contagem inicial está desatualizada. Vale repetir a ronda nestes endereços nos próximos dias.' : 'Parte do estoque não bateu — as correções já foram aplicadas.';
    const cel = (v, rot) => `<div class="rs-c"><b>${v}</b><span>${rot}</span></div>`;
    return `<div class="rd-start"><h2>Ronda ${feitos === turno.n ? 'concluída' : 'encerrada'}</h2>
      <p class="muted">${feitos} de ${turno.n} endereços em ${min} min${feitos ? ` · ${(min / feitos).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} min por endereço` : ''}</p>
      <div class="rs-grid">${cel(itens, 'itens conferidos')}${cel(`${t.fix + t.zero} <small>(${div.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%)</small>`, 'não bateram')}${cel(t.etq, 'etiquetas coladas')}${cel(t.ret, 'vencidos retirados')}${cel(t.mov, 'itens movidos')}${cel(t.semBip, 'sem leitura do código')}</div>
      ${leitura ? `<p class="small" style="margin:14px 0">${esc(leitura)}</p>` : ''}
      <button id="rNova" class="big primary">Nova ronda</button></div>`;
  }

  function encerraTurno() {
    if (!turno) return;
    turno.fim = Date.now(); salvaTurno(); emTurno = -1; mostraRonda('dia');
  }

  function proximoDoTurno(de) {
    const k = turno.itens.findIndex((t, i) => i > de && !t.feito && !t.pulou);
    return k >= 0 ? k : turno.itens.findIndex(t => !t.feito && !t.pulou);
  }

  function avancaTurno() {
    const k = proximoDoTurno(emTurno);
    if (k < 0) { if (turno.itens.every(t => t.feito)) return encerraTurno(); emTurno = -1; return mostraRonda('dia'); }
    abreTurno(k);
  }

  function abreTurno(i) { emTurno = i; carregaRonda(turno.itens[i].e); }

  async function carregaRonda(end, manter = false) {
    end = (end || '').trim().toUpperCase();
    if (!end) return;
    if (!manter && end === rondaChave && Date.now() - rondaTs < 500) return; // Enter + change disparam juntos
    rondaChave = end; rondaTs = Date.now();
    try {
      const r = await api('/api/enderecos/' + encodeURIComponent(end));
      if (!manter || rondaEnd !== r.endereco) { rondaFeitos = new Set(); bipados = new Set(); }
      rondaEnd = r.endereco; rondaItens = r.itens;
      $('#rEnd').value = rondaEnd;
      const pos = emTurno >= 0 ? `<b>Endereço ${emTurno + 1} de ${turno.n}</b> · ` : '';
      $('#rInfo').innerHTML = pos + (descEndereco(rondaEnd) ? esc(descEndereco(rondaEnd)) + ' · ' : '') + (r.ultima_contagem ? `última contagem ${brDataHora(r.ultima_contagem)}` : 'nunca contado')
        + (r.endereco_ok ? '' : ' · <span style="color:var(--warn)">endereço fora do padrão — mova os itens para o endereço certo</span>');
      $('#rTrocarTxt').textContent = emTurno >= 0 ? 'Lista' : 'Trocar endereço';
      $('#rFim').hidden = emTurno < 0;
      mostraRonda('corpo');
      desenhaRonda();
      window.scrollTo({ top: 0 });
      if (!matchMedia('(pointer: coarse)').matches) $('#rBusca').focus({ preventScroll: true });
    } catch (e) { toast(e.status ? e.message : 'Sem conexão para carregar a ronda', 'bad'); }
  }

  function desenhaRonda() {
    const feitos = rondaItens.filter(i => rondaFeitos.has(i.id)).length;
    $('#rProg').firstElementChild.style.width = rondaItens.length ? (feitos / rondaItens.length * 100) + '%' : '100%';
    $('#rConta').textContent = `${feitos} de ${rondaItens.length} conferidos`;
    const tudo = rondaItens.every(i => rondaFeitos.has(i.id));
    const cc = $('#rConcluir'); if (cc) cc.classList.toggle('primary', tudo);
    $('#rLista').innerHTML = (rondaItens.length ? '' : '<p class="muted" style="margin-bottom:12px">Nada neste endereço (ou tudo já foi retirado). Use “＋ Item” para incluir o que encontrar.</p>') +
      rondaItens.map((i, k) => {
        const feito = rondaFeitos.has(i.id), venc = i.dias <= 0, precisaBip = !venc && exigeBip(i) && !bipados.has(i.id);
        const faixa = venc ? '<div class="etq venc">Vencido: retirar da prateleira e mandar para RMA (CD)</div>'
          : i.etiquetar ? `<div class="etq">${ico('tag')}<span>Etiquetar ${i.desconto}% e levar para a frente</span><button class="sm primary" data-r="etq" data-id="${i.id}">Etiquetei</button></div>`
          : i.etiquetado ? `<div class="etq ok">${ico('check')}<span>Etiquetado ${i.desconto}%</span></div>` : '';
        return `
      <div class="citem ${feito ? 'feito' : ''}" id="ri-${i.id}" style="animation-delay:${Math.min(k, 8) * 40}ms">
        <div><div class="pname">${esc(i.nome || i.ean)}</div><div class="muted small">lote ${esc(i.lote)} · ${esc(i.ean)}${i.desconto ? ` · oferta ${i.desconto}%` : ''}</div>${i.preco == null ? `<button class="sm subtle" data-r="preco" data-id="${i.id}" style="margin:4px 0 0 -10px">＋ Informar preço</button>` : `<div class="xs muted">${brl(i.preco)}</div>`}</div>
        <div style="text-align:right">${pill(i.status, i.cor)}<div class="small" style="margin-top:3px">${brData(i.validade)}</div></div>
        ${faixa}
        <div class="acts">
          ${venc ? `<button data-r="ret" data-id="${i.id}" class="primary">Retirei (RMA)</button>` : ''}
          ${venc ? '' : `<button data-r="${precisaBip ? 'bip' : 'ok'}" data-id="${i.id}" class="${feito || !i.endereco_ok ? '' : 'primary'}">${precisaBip ? ico('camera') + ' Bipar para confirmar' : ico('check') + ' ' + i.qtd + ' un. conferem'}</button>`}
          <button data-r="fix" data-id="${i.id}">Corrigir</button>
          <button data-r="zero" data-id="${i.id}" class="danger">Não achei</button>
          <button data-r="mov" data-id="${i.id}" class="${i.endereco_ok ? '' : 'primary'}">${ico('move')} Mover</button>
        </div>
        ${precisaBip && !feito ? `<button class="sm subtle" data-r="semcod" data-id="${i.id}" style="justify-self:start;grid-column:1/-1">Código ilegível ou sem etiqueta</button>` : ''}
      </div>`;
      }).join('');
  }

  async function registra(it, qtd, motivo, tally) {
    const r = await lancar({ tipo: 'CONTAGEM', lote_id: it.id, qtd, motivo });
    rondaFeitos.add(it.id); it.qtd = qtd; conta(tally);
    if (r.grupo) mostraUndo(r.grupo, `${motivo.replace('Ronda: ', '')}: ${qtd} × ${it.nome}`, it.id, tally);
    if (qtd === 0) rondaItens = rondaItens.filter(x => x.id !== it.id);
    desenhaRonda();
  }

  async function acaoRonda(b) {
    const it = rondaItens.find(i => i.id === +b.dataset.id);
    if (!it) return;
    const a = b.dataset.r;
    if (a === 'ok') return registra(it, it.qtd, 'Ronda: confere', 'conf');
    if (a === 'preco') {
      const d = await dialogo({ titulo: 'Preço de venda', sub: it.nome || it.ean, campos: [{ id: 'p', label: 'Preço (R$)', valor: '', inputmode: 'decimal' }] });
      if (!d) return;
      const p = d.p.trim();
      if (!/^d+([.,]d{1,2})?$/.test(p)) { toast('Preço inválido (ex.: 39,90)', 'bad'); return; }
      const r = await api('/api/produtos', { method: 'POST', body: { ean: it.ean, nome: it.nome, preco: p.replace(',', '.') } });
      rondaItens.filter(x => x.ean === it.ean).forEach(x => { x.preco = r.preco; });
      toast('Preço salvo', 'ok', 1800);
      return desenhaRonda();
    }
    if (a === 'bip') {
      const v = await Scanner.abrir({ titulo: `Bipe: ${it.nome || it.ean}`, aceitar: 'ean' });
      if (!v) return;
      if (kEan(v) !== kEan(it.ean)) { beep(false); toast('Esse código não é deste produto', 'bad', 3500); return; }
      bipados.add(it.id);
      return registra(it, it.qtd, 'Ronda: confere', 'conf');
    }
    if (a === 'semcod') {
      if (!confirm('Confirmar sem ler o código? Isso fica registrado.')) return;
      bipados.add(it.id);
      conta('semBip');
      return registra(it, it.qtd, 'Ronda: confere (sem bipar)', 'conf');
    }
    if (a === 'fix') {
      const d = await dialogo({ titulo: 'Quantidade contada', sub: `${it.nome} · lote ${it.lote} (sistema: ${it.qtd})`, campos: [{ id: 'q', label: 'Quantidade real', valor: it.qtd, inputmode: 'numeric' }] });
      if (!d || !/^\d+$/.test(d.q.trim())) return;
      return registra(it, +d.q, 'Ronda: corrigido', 'fix');
    }
    if (a === 'zero') {
      if (!confirm(`Confirma que NÃO há mais "${it.nome}" (lote ${it.lote}) aqui?`)) return;
      return registra(it, 0, 'Ronda: não encontrado', 'zero');
    }
    if (a === 'ret') {
      if (!confirm(`Confirma que retirou ${it.qtd} un. de "${it.nome}" (lote ${it.lote}, vencido) da loja para o RMA?`)) return;
      const r = await lancar({ tipo: 'BAIXA', lote_id: it.id, qtd: it.qtd, motivo: 'RMA' });
      conta('ret');
      if (r.grupo) mostraUndo(r.grupo, `Retirado: ${it.qtd} × ${it.nome}`, it.id, 'ret');
      rondaItens = rondaItens.filter(x => x.id !== it.id);
      return desenhaRonda();
    }
    if (a === 'etq') {
      const r = await lancar({ tipo: 'ETIQUETA', lote_id: it.id, desconto: it.desconto });
      it.etiquetado = true; it.etiquetar = false; conta('etq');
      if (r.grupo) mostraUndo(r.grupo, `Etiquetado ${it.desconto}%: ${it.nome}`, null, 'etq');
      return desenhaRonda();
    }
    if (a === 'mov') {
      const d = await dialogo({ titulo: 'Mover de endereço', sub: `${it.nome} · lote ${it.lote} (aqui: ${it.qtd})`, campos: [
        { id: 'q', label: 'Quantidade a mover', valor: it.qtd, inputmode: 'numeric' },
        { id: 'dest', label: 'Endereço de destino (ex.: 7-B-2)', valor: '' }] });
      if (!d) return;
      const q = d.q.trim(), dest = d.dest.trim().toUpperCase();
      if (!/^\d+$/.test(q) || +q < 1 || +q > it.qtd) { toast('Quantidade inválida', 'bad'); return; }
      if (!parseEndereco(dest).valido) { toast('Destino fora do padrão (ex.: 7-B-2)', 'bad'); return; }
      const r = await lancar({ tipo: 'TRANSFERENCIA', lote_id: it.id, qtd: +q, endereco_destino: dest });
      conta('mov');
      if (r.grupo) mostraUndo(r.grupo, `Movido: ${q} × ${it.nome} → ${dest}`, null, 'mov');
      if (+q === it.qtd) rondaItens = rondaItens.filter(x => x.id !== it.id); else it.qtd -= +q;
      return desenhaRonda();
    }
  }

  // ---------- ligação dos eventos ----------
  function ligar() {
    CFG = null;
    api('/api/config').then(x => { CFG = x; VALMIN = x.validade_minima || 0; }).catch(() => {});
    $$('.cmodes button').forEach(b => b.addEventListener('click', () => setModo(b.dataset.modo)));
    $('#tReceber').addEventListener('click', () => setTipo('RECEBIMENTO'));
    $('#tContar').addEventListener('click', () => setTipo('CONTAGEM'));

    // câmera
    $$('button.cam').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.cam, texto = id === 'end' || id === 'rEnd';
      try {
        const v = await Scanner.abrir({ titulo: texto ? 'Aponte para a etiqueta do endereço' : 'Aponte para o código de barras do produto', aceitar: texto ? 'texto' : 'ean' });
        if (!v) return;
        const el = $('#' + id);
        el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
        if (enter[id]) enter[id]();
      } catch (er) { toast(er.message, 'bad', 6000); }
    }));

    // desfazer e recusados
    $('#undoBtn').addEventListener('click', async () => {
      if (!ultimo) return;
      try {
        await api('/api/desfazer', { method: 'POST', body: { grupo: ultimo } });
        toast('Desfeito', 'ok'); $('#undo').hidden = true; ultimo = null;
        if (ultimoLote) rondaFeitos.delete(ultimoLote);
        if (ultimoTally && turno && !turno.fim && turno.tally[ultimoTally] > 0) { turno.tally[ultimoTally]--; salvaTurno(); }
        if (modo === 'ronda' && rondaEnd && !$('#rCorpo').hidden) carregaRonda(rondaEnd, true);
      }
      catch (e) { toast(e.message, 'bad', 5000); }
    });
    $('#rejeitados').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; const r = Fila.rejeitados(); r.splice(+b.dataset.i, 1); lsSet('rejeitados', r); Fila.atualiza(); });

    // entrada
    $('#endChips').addEventListener('click', e => {
      const b = e.target.closest('button.chip');
      if (!b) return;
      const q = partes($('#end').value);
      if (!q) { toast('Digite o número da gôndola primeiro', 'bad'); $('#end').focus(); return; }
      const lado = b.dataset.lado || q.lado || 'A';
      const nivel = b.dataset.nivel ? +b.dataset.nivel : q.nivel;
      $('#end').value = `${q.g}-${lado}${nivel ? '-' + nivel : ''}`;
      atualizaEnd();
    });
    $('#end').addEventListener('input', atualizaEnd);
    $('#end').addEventListener('change', e => { e.target.value = e.target.value.trim().toUpperCase(); atualizaEnd(); });
    aoEnter('end', () => { $('#end').value = $('#end').value.trim().toUpperCase(); atualizaEnd(); $('#ean').focus(); });
    aoEnter('ean', buscaProdutoEntrada);
    aoEnter('cNome', () => $('#cPreco').focus());
    aoEnter('cPreco', () => $('#lote').focus());
    aoEnter('pPreco', () => $('#lote').focus());
    aoEnter('lote', () => $('#val').focus());
    aoEnter('val', () => $('#qtd').focus());
    aoEnter('qtd', salvarEntrada);
    $('#salvar').addEventListener('click', salvarEntrada);
    $('#val').addEventListener('input', previaValidade);
    $('#prod').addEventListener('click', e => {
      const c = e.target.closest('button[data-lote]');
      if (!c) return;
      $('#lote').value = c.dataset.lote; $('#val').value = brData(c.dataset.val); previaValidade();
      if (!$('#end').value) { $('#end').value = c.dataset.end; atualizaEnd(); }
      $('#qtd').focus();
    });

    // ronda
    aoEnter('rEnd', () => carregaRonda($('#rEnd').value));
    $('#rEnd').addEventListener('change', () => { if ($('#rEnd').value.trim()) { emTurno = -1; carregaRonda($('#rEnd').value); } });
    $('#rCarregar').addEventListener('click', () => { emTurno = -1; carregaRonda($('#rEnd').value); });
    $('#rVoltaDia').addEventListener('click', () => mostraRonda('dia'));
    $('#rTrocar').addEventListener('click', () => {
      if (emTurno >= 0) { emTurno = -1; mostraRonda('dia'); return; }
      $('#rEnd').value = ''; rondaChave = ''; mostraRonda('escolha');
    });
    $('#rDia').addEventListener('click', e => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.dataset.n) { lsSet('rondaN', +t.dataset.n); desenhaDia(); }
      else if (t.dataset.minhas) { lsSet('rondaMinhas', t.dataset.minhas === '1'); $$('#rFiltro button').forEach(x => x.setAttribute('aria-pressed', x === t)); }
      else if (t.id === 'rGerar') gerarTurno();
      else if (t.id === 'rManual') { emTurno = -1; mostraRonda('escolha'); }
      else if (t.id === 'rNova') { turno = null; salvaTurno(); desenhaDia(); }
      else if (t.id === 'rEncerrar') {
        if (turno.itens.every(i => i.feito) || confirm('Encerrar a ronda agora? Os endereços que faltam continuam na fila de amanhã.')) encerraTurno();
      } else if (t.classList.contains('alvo')) abreTurno(+t.dataset.i);
    });
    $('#rPular').addEventListener('click', () => { turno.itens[emTurno].pulou = true; salvaTurno(); avancaTurno(); });
    $('#rConcluir').addEventListener('click', () => {
      const falta = rondaItens.filter(i => !rondaFeitos.has(i.id)).length;
      const semEtiqueta = rondaItens.filter(i => i.etiquetar).length;
      const avisos = [];
      if (falta) avisos.push(`${falta} item(ns) ainda sem conferir`);
      if (semEtiqueta) avisos.push(`${semEtiqueta} item(ns) sem etiqueta de desconto`);
      if (avisos.length && !confirm(`${avisos.join(' e ')}. Concluir este endereço mesmo assim?`)) return;
      turno.itens[emTurno].feito = true; salvaTurno(); avancaTurno();
    });
    $('#rLista').addEventListener('click', async e => {
      const b = e.target.closest('button[data-r]');
      if (!b || b.disabled) return;
      b.disabled = true;
      try { await acaoRonda(b); }
      catch (er) { toast(er.message || 'Não consegui registrar', 'bad', 5000); }
      finally { b.disabled = false; }
    });
    aoEnter('rBusca', () => {
      const v = $('#rBusca').value.replace(/\D/g, ''); $('#rBusca').value = '';
      if (!v) return;
      const alvo = rondaItens.find(i => kEan(i.ean) === kEan(v) && !rondaFeitos.has(i.id)) || rondaItens.find(i => kEan(i.ean) === kEan(v));
      if (!alvo) { beep(false); toast('Este produto não estava na lista do endereço. Use “＋ Item que não estava na lista”.', 'bad', 4500); return; }
      beep(true);
      const el = $('#ri-' + alvo.id); el.classList.add('destaque'); el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => el.classList.remove('destaque'), 2500);
      if (exigeBip(alvo) && !rondaFeitos.has(alvo.id) && alvo.dias > 0) {      // ler o código é a confirmação dos itens que vencem logo
        bipados.add(alvo.id);
        registra(alvo, alvo.qtd, 'Ronda: confere', 'conf').catch(er => toast(er.message || 'Não consegui registrar', 'bad', 5000));
      }
    });
    $('#rNovo').addEventListener('click', () => { $('#end').value = rondaEnd; atualizaEnd(); setTipo('CONTAGEM'); setModo('entrada'); $('#ean').focus(); });

    // baixa
    aoEnter('bEan', async () => {
      const ean = $('#bEan').value.replace(/\D/g, '');
      if (!ean) return;
      try {
        const r = await api('/api/produto/' + ean);
        if (!r.cadastrado) { beep(false); $('#bLista').innerHTML = '<p style="color:var(--bad)">EAN não cadastrado.</p>'; return; }
        window.__baixaLotes = r.lotes;
        $('#bLista').innerHTML = `<div class="prod"><b>${esc(r.produto.nome)}</b></div>` + (r.lotes.length ? r.lotes.map(l => `
          <div class="citem"><div><div class="pname">lote ${esc(l.lote)}</div><div class="muted small">${addr(l.endereco, l.endereco_ok)} · ${l.qtd} un.</div></div>
          <div style="text-align:right">${pill(l.status, l.cor)}<div class="small" style="margin-top:3px">${brData(l.validade)}</div></div>
          <div class="acts"><button class="primary" data-b="${l.id}">Dar baixa</button></div></div>`).join('') : '<p class="muted">Sem estoque deste produto.</p>');
        beep(true);
      } catch (e) { toast('Não consegui consultar: ' + e.message, 'bad'); }
    });
    $('#bLista').addEventListener('click', async e => {
      const b = e.target.closest('button[data-b]');
      if (!b) return;
      const l = window.__baixaLotes.find(x => x.id === +b.dataset.b);
      CFG = CFG || await api('/api/config').catch(() => ({ motivos_baixa: ['Venda', 'RMA', 'Avaria', 'Furto', 'Retirada Preventiva', 'Doação', 'Outro'] }));
      const d = await dialogo({ titulo: 'Dar baixa', sub: `lote ${l.lote} · saldo ${l.qtd}`, campos: [
        { id: 'q', label: 'Quantidade', valor: l.qtd, inputmode: 'numeric' },
        { id: 'm', label: 'Motivo', tipo: 'select', opcoes: l.dias <= 0 ? ['RMA', ...CFG.motivos_baixa.filter(x => x !== 'RMA')] : CFG.motivos_baixa }] });
      if (!d || !/^\d+$/.test(d.q.trim()) || +d.q < 1) return;
      try {
        const r = await lancar({ tipo: 'BAIXA', lote_id: l.id, qtd: +d.q, motivo: d.m });
        if (r.grupo) mostraUndo(r.grupo, `Baixa: ${d.q} × lote ${l.lote} (${d.m})`);
        toast('Baixa registrada', 'ok', 2000);
        $('#bEan').value = ''; $('#bLista').innerHTML = ''; $('#bEan').focus();
      } catch (er) { toast(er.message, 'bad', 5000); }
    });

    // busca
    aoEnter('sEan', async () => {
      const v = $('#sEan').value.trim();
      if (!v) return;
      try {
        const soDig = /^\d{8,14}$/.test(v);
        const lotes = soDig ? (await api('/api/produto/' + v)).lotes : (await api('/api/lotes?limite=40&q=' + encodeURIComponent(v))).itens;
        beep(true);
        $('#sLista').innerHTML = lotes.length ? lotes.map(l => `
          <div class="citem"><div><div class="pname">${esc(l.nome || l.ean)}</div><div class="muted small">lote ${esc(l.lote)} · ${l.qtd} un.</div></div>
          <div style="text-align:right">${pill(l.status, l.cor)}<div class="small" style="margin-top:3px">${brData(l.validade)}</div></div>
          <div style="grid-column:1/-1"><div style="font:700 26px var(--font-display);letter-spacing:-.02em">${esc(l.endereco || 'sem endereço')}</div><div class="small muted">${esc(descEndereco(l.endereco))}</div></div></div>`).join('') : '<p class="muted">Nada encontrado em estoque.</p>';
      } catch (e) { toast('Não consegui consultar: ' + e.message, 'bad'); }
      $('#sEan').select();
    });

    $('#end').value = lsGet('ultimoEnd', ''); atualizaEnd();
    setModo(lsGet('coletorModo', 'entrada'), false);
    carregaEnderecos();
    Fila.atualiza();
  }

  return { html, ligar };
})();
