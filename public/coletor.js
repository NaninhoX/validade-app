'use strict';
// ---------- estado ----------
let modo = 'entrada', tipoEntrada = 'RECEBIMENTO';
let produtoAtual = null;
let rondaItens = [], rondaFeitos = new Set(), rondaEnd = '';
let CFG = null, LOGIN = false, NOME = 'LOCAL';
const enter = {}; // ação do Enter por campo (usada também depois da leitura pela câmera)

// ---------- som / vibração ----------
let ac;
function beep(ok = true) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(ac.destination);
    g.gain.value = 0.08; o.start(); o.stop(ac.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* sem áudio */ }
  if (!ok && navigator.vibrate) navigator.vibrate(200);
}

// ---------- fila offline ----------
const fila = () => lsGet('fila', []);
const rejeitados = () => lsGet('rejeitados', []);
function atualizaPill() {
  const n = fila().length, p = $('#sync');
  p.className = 'sync' + (!navigator.onLine ? ' off' : n ? ' pend' : '');
  p.textContent = !navigator.onLine ? `Offline${n ? ' · ' + n : ''}` : n ? `Enviando ${n}…` : 'Sincronizado';
  const rej = rejeitados(), box = $('#rejeitados');
  box.hidden = !rej.length;
  box.innerHTML = rej.length ? `<b>${rej.length} lançamento(s) recusado(s)</b>` + rej.map((r, i) => `<div style="margin-top:8px">${esc(r.body.ean || r.body.lote_id)} — ${esc(r.erro)} <button class="sm" data-i="${i}">descartar</button></div>`).join('') : '';
}
$('#rejeitados').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; const r = rejeitados(); r.splice(+b.dataset.i, 1); lsSet('rejeitados', r); atualizaPill(); });
$('#sync').addEventListener('click', () => flush());

let enviando = false;
async function flush() {
  if (enviando) return;
  enviando = true;
  try {
    for (;;) {
      const f = fila();
      if (!f.length) break;
      try {
        const r = await api('/api/leituras', { method: 'POST', body: f[0] });
        lsSet('fila', fila().slice(1));
        if (r.avisos?.length) toast(r.avisos.join(' · '));
      } catch (e) {
        if (e.status) { const rej = rejeitados(); rej.push({ body: f[0], erro: e.message }); lsSet('rejeitados', rej); lsSet('fila', fila().slice(1)); }
        else break; // sem rede: tenta depois
      }
    }
  } finally { enviando = false; atualizaPill(); }
}
window.addEventListener('online', flush);
window.addEventListener('offline', atualizaPill);
setInterval(flush, 10000);

async function lancar(body) {
  body = { client_id: uuid(), operador: NOME, ts: new Date().toISOString(), ...body };
  try {
    const r = await api('/api/leituras', { method: 'POST', body });
    beep(true);
    return r;
  } catch (e) {
    if (e.status) { beep(false); throw e; }
    lsSet('fila', [...fila(), body]);
    atualizaPill(); beep(true);
    return { fila: true, avisos: [] };
  }
}

// ---------- operador ----------
async function inicia() {
  $('#logo').innerHTML = ico('scan', 18);
  $$('[data-i]').forEach(s => { s.innerHTML = ico(s.dataset.i); });
  $$('.cam').forEach(b => { b.innerHTML = ico('camera', 24); });
  let eu = lsGet('eu', null);
  try { eu = await api('/api/eu'); lsSet('eu', eu); } catch (e) { if (!eu) toast('Sem conexão com o servidor', 'bad'); }
  eu = eu || { login: false, operadores: [] };
  LOGIN = eu.login;
  if (LOGIN) {
    NOME = eu.usuario?.nome || 'COLETOR';
    $('#meNome').textContent = NOME;
    const s = $('#sair'); s.hidden = false; s.innerHTML = ico('logout');
    s.addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: {}, semRedirect: true }); lsSet('eu', null); location.href = '/login?volta=/coletor'; });
  } else {
    const ops = eu.operadores.length ? eu.operadores : ['COLETOR'];
    const sel = $('#operador'); sel.hidden = false;
    NOME = lsGet('operador', ops[0]);
    sel.innerHTML = ops.map(o => `<option ${o === NOME ? 'selected' : ''}>${esc(o)}</option>`).join('');
    sel.addEventListener('change', e => { NOME = e.target.value; lsSet('operador', NOME); });
    $('#meNome').textContent = 'Coletor';
  }
  atualizaPill(); carregaEnderecos(); flush();
  $('#end').value = lsGet('ultimoEnd', ''); atualizaEnd();
  setModo('entrada');
}

async function carregaEnderecos() {
  let l = lsGet('enderecos', []);
  try { l = (await api('/api/enderecos')).map(e => e.endereco).filter(Boolean); lsSet('enderecos', l); } catch { /* cache */ }
  $('#listaEnd').innerHTML = l.map(e => `<option value="${esc(e)}">`).join('');
}

// ---------- modos ----------
function setModo(m) {
  modo = m;
  $$('.tabbar button').forEach(b => b.setAttribute('aria-pressed', b.dataset.modo === m));
  ['entrada', 'ronda', 'baixa', 'busca'].forEach(x => { $('#m-' + x).hidden = x !== m; });
  scrollTo({ top: 0 });
  ({ entrada: () => ($('#end').value ? $('#ean') : $('#end')), ronda: () => $('#rEnd'), baixa: () => $('#bEan'), busca: () => $('#sEan') }[m]()).focus({ preventScroll: true });
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => setModo(b.dataset.modo)));

function aoEnter(id, fn) { enter[id] = fn; $('#' + id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } }); }

// ---------- câmera ----------
document.addEventListener('click', async e => {
  const b = e.target.closest('button.cam');
  if (!b) return;
  const id = b.dataset.cam, texto = id === 'end' || id === 'rEnd';
  try {
    const v = await Scanner.abrir({ titulo: texto ? 'Aponte para a etiqueta do endereço' : 'Aponte para o código de barras do produto', aceitar: texto ? 'texto' : 'ean' });
    if (!v) return;
    const el = $('#' + id);
    el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    if (enter[id]) enter[id]();
  } catch (er) { toast(er.message, 'bad', 6000); }
});

// ---------- diálogo ----------
function dialogo({ titulo, sub, campos }) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    $('#dlgTitulo').textContent = titulo; $('#dlgSub').textContent = sub || '';
    $('#dlgCampos').innerHTML = campos.map(c => `<div class="f-wrap"><label class="f" for="d_${c.id}">${esc(c.label)}</label>${
      c.tipo === 'select' ? `<select id="d_${c.id}">${c.opcoes.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
        : `<input id="d_${c.id}" ${c.inputmode ? `inputmode="${c.inputmode}"` : ''} value="${esc(c.valor ?? '')}" autocomplete="off">`}</div>`).join('');
    const fim = v => { dlg.close(); resolve(v); };
    $('#dlgCancel').onclick = () => fim(null);
    $('#dlgForm').onsubmit = e => { e.preventDefault(); fim(Object.fromEntries(campos.map(c => [c.id, $('#d_' + c.id).value]))); };
    dlg.addEventListener('cancel', () => resolve(null), { once: true });
    dlg.showModal();
    const f = $('#d_' + campos[0].id); f.focus(); if (f.select) f.select();
  });
}

// ---------- desfazer ----------
let ultimo = null, undoTimer;
function mostraUndo(grupo, txt) {
  ultimo = grupo;
  if (!grupo) return;
  $('#undoTxt').textContent = txt; $('#undo').hidden = false;
  clearTimeout(undoTimer); undoTimer = setTimeout(() => { $('#undo').hidden = true; }, 45000);
}
$('#undoBtn').addEventListener('click', async () => {
  if (!ultimo) return;
  try { await api('/api/desfazer', { method: 'POST', body: { grupo: ultimo } }); toast('Desfeito', 'ok'); $('#undo').hidden = true; ultimo = null; if (modo === 'ronda') carregaRonda(rondaEnd, true); }
  catch (e) { toast(e.message, 'bad', 5000); }
});

// =====================================================================
// ENTRADA
// =====================================================================
$('#tReceber').addEventListener('click', () => setTipo('RECEBIMENTO'));
$('#tContar').addEventListener('click', () => setTipo('CONTAGEM'));
function setTipo(t) { tipoEntrada = t; $('#tReceber').setAttribute('aria-pressed', t === 'RECEBIMENTO'); $('#tContar').setAttribute('aria-pressed', t === 'CONTAGEM'); }

// Atalhos do endereço: toque no lado e na prateleira em vez de digitar
const partes = v => { const m = String(v || '').trim().toUpperCase().match(/^(\d{1,2})(?:-([ABFC]))?(?:-(\d))?$/); return m ? { g: m[1], lado: m[2] || null, nivel: m[3] ? +m[3] : null } : null; };
function atualizaEnd() {
  const v = $('#end').value, p = parseEndereco(v), q = partes(v);
  $('#endDesc').innerHTML = !v.trim() ? 'Gôndola-lado-prateleira. Ex.: 1-B-3 (lado B, prateleira 3) · 1-F ou 1-C = ponta'
    : p.valido ? `<span style="color:var(--good)">✓</span> ${esc(descEndereco(v))}` : q ? 'Falta o lado (A, B, F ou C) e a prateleira (1 a 5)' : '<span style="color:var(--bad)">Endereço fora do padrão</span>';
  const linha = (rot, itens) => `<div class="chips" style="margin:0;width:100%;align-items:center"><span class="small muted" style="width:70px">${rot}</span>${itens}</div>`;
  $('#endChips').innerHTML =
    linha('Lado', ['A', 'B', 'F', 'C'].map(l => `<button class="chip sq" data-lado="${l}" aria-pressed="${q?.lado === l}" title="${LADO_TXT[l]}">${l}</button>`).join('')) +
    linha('Prateleira', [1, 2, 3, 4, 5].map(n => `<button class="chip sq" data-nivel="${n}" aria-pressed="${q?.nivel === n}">${n}</button>`).join(''));
  lsSet('ultimoEnd', v);
}
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
aoEnter('ean', () => buscaProdutoEntrada());
aoEnter('cNome', () => $('#cPreco').focus());
aoEnter('cPreco', () => $('#lote').focus());
aoEnter('lote', () => $('#val').focus());
aoEnter('val', () => $('#qtd').focus());
aoEnter('qtd', () => salvarEntrada());
$('#salvar').addEventListener('click', salvarEntrada);

async function buscaProdutoEntrada() {
  const ean = $('#ean').value.trim();
  if (!ean) return;
  produtoAtual = null;
  $('#prod').hidden = true; $('#cadRapido').hidden = true;
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
  }
  $('#lote').focus();
}
$('#prod').addEventListener('click', e => {
  const c = e.target.closest('button[data-lote]');
  if (!c) return;
  $('#lote').value = c.dataset.lote; $('#val').value = brData(c.dataset.val); previaValidade();
  if (!$('#end').value) { $('#end').value = c.dataset.end; atualizaEnd(); }
  $('#qtd').focus();
});

function previaValidade() {
  const v = $('#val').value.trim(), el = $('#prev');
  if (!v) { el.textContent = ''; return null; }
  const iso = parseData(v);
  if (!iso) { el.innerHTML = '<span style="color:var(--bad)">data inválida</span>'; return null; }
  const d = diasAte(iso);
  const cor = d <= 0 ? 'var(--bad)' : d <= 30 ? '#f97316' : d <= 90 ? 'var(--warn)' : 'var(--good)';
  el.innerHTML = `<b style="color:${cor}">${brData(iso)}</b> · ${d < 0 ? 'vencido há ' + (-d) + ' dias' : d === 0 ? 'vence hoje' : 'em ' + d + ' dias'}`;
  return iso;
}
$('#val').addEventListener('input', previaValidade);

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
  $('#salvar').disabled = true;
  try {
    const r = await lancar(body);
    const nome = produtoAtual?.produto?.nome || body.nome || ean;
    $('#avisos').innerHTML = (r.avisos || []).map(a => `<div class="aviso">${ico('alert')}<span>${esc(a)}</span></div>`).join('');
    if (r.avisos?.length) beep(false);
    toast(r.fila ? 'Guardado — será enviado quando a rede voltar' : `${tipoEntrada === 'RECEBIMENTO' ? '+' : '='}${qtd} ${nome}`, r.fila ? '' : 'ok', 2500);
    if (r.grupo) mostraUndo(r.grupo, `${tipoEntrada === 'RECEBIMENTO' ? 'Recebido' : 'Contado'}: ${qtd} × ${nome}`);
    ['ean', 'lote', 'val', 'qtd', 'cNome', 'cPreco'].forEach(id => { $('#' + id).value = ''; });
    $('#prev').textContent = ''; $('#prod').hidden = true; $('#cadRapido').hidden = true; produtoAtual = null;
    $('#ean').focus();
    carregaEnderecos();
  } catch (e) { toast(e.message, 'bad', 5000); }
  finally { $('#salvar').disabled = false; }
}

// =====================================================================
// RONDA
// =====================================================================
aoEnter('rEnd', () => carregaRonda($('#rEnd').value));
$('#rEnd').addEventListener('change', () => { if ($('#rEnd').value.trim()) carregaRonda($('#rEnd').value); });
$('#rCarregar').addEventListener('click', () => carregaRonda($('#rEnd').value));

let rondaTs = 0, rondaChave = '';
async function carregaRonda(end, manter = false) {
  end = (end || '').trim().toUpperCase();
  if (!end) return;
  if (!manter && end === rondaChave && Date.now() - rondaTs < 500) return; // Enter + change disparam juntos
  rondaChave = end; rondaTs = Date.now();
  try {
    const r = await api('/api/enderecos/' + encodeURIComponent(end));
    if (!manter || rondaEnd !== r.endereco) rondaFeitos = new Set();
    rondaEnd = r.endereco; rondaItens = r.itens;
    $('#rEnd').value = rondaEnd;
    $('#rInfo').innerHTML = (descEndereco(rondaEnd) ? esc(descEndereco(rondaEnd)) + ' · ' : '') + (r.ultima_contagem ? `última contagem ${brDataHora(r.ultima_contagem)}` : 'nunca contado')
      + (r.endereco_ok ? '' : ' · <span style="color:var(--warn)">endereço fora do padrão</span>');
    $('#rBuscaBox').hidden = false; $('#rNovo').hidden = false; $('#rProg').hidden = false;
    desenhaRonda();
    $('#rBusca').focus({ preventScroll: true });
  } catch (e) { toast(e.status ? e.message : 'Sem conexão para carregar a ronda', 'bad'); }
}
function desenhaRonda() {
  const feitos = rondaItens.filter(i => rondaFeitos.has(i.id)).length;
  $('#rProg').firstElementChild.style.width = rondaItens.length ? (feitos / rondaItens.length * 100) + '%' : '100%';
  $('#rLista').innerHTML = (rondaItens.length ? '' : '<p class="muted">Nada cadastrado neste endereço. Use “＋ Item” para incluir o que encontrar.</p>') +
    `<div class="small muted" style="margin-bottom:10px">${feitos} de ${rondaItens.length} conferidos</div>` +
    rondaItens.map((i, k) => `
    <div class="item ${rondaFeitos.has(i.id) ? 'feito' : ''}" id="ri-${i.id}" style="animation-delay:${Math.min(k, 8) * 40}ms">
      <div><div class="pname">${esc(i.nome || i.ean)}</div><div class="muted small">lote ${esc(i.lote)} · ${esc(i.ean)}${i.desconto ? ` · oferta ${i.desconto}%` : ''}</div></div>
      <div style="text-align:right">${pill(i.status, i.cor)}<div class="small" style="margin-top:3px">${brData(i.validade)}</div></div>
      <div class="acts">
        <button data-r="ok" data-id="${i.id}" class="${rondaFeitos.has(i.id) ? '' : 'primary'}">${ico('check')} ${i.qtd} un. conferem</button>
        <button data-r="fix" data-id="${i.id}">Corrigir</button>
        <button data-r="zero" data-id="${i.id}" class="danger">Não achei</button>
      </div></div>`).join('');
}
$('#rLista').addEventListener('click', async e => {
  const b = e.target.closest('button[data-r]');
  if (!b) return;
  const it = rondaItens.find(i => i.id === +b.dataset.id);
  let qtd = it.qtd, motivo = 'Ronda: confere';
  if (b.dataset.r === 'fix') {
    const d = await dialogo({ titulo: 'Quantidade contada', sub: `${it.nome} · lote ${it.lote} (sistema: ${it.qtd})`, campos: [{ id: 'q', label: 'Quantidade real', valor: it.qtd, inputmode: 'numeric' }] });
    if (!d || !/^\d+$/.test(d.q.trim())) return;
    qtd = +d.q; motivo = 'Ronda: corrigido';
  } else if (b.dataset.r === 'zero') {
    if (!confirm(`Confirma que NÃO há mais "${it.nome}" (lote ${it.lote}) aqui?`)) return;
    qtd = 0; motivo = 'Ronda: não encontrado';
  }
  try {
    const r = await lancar({ tipo: 'CONTAGEM', lote_id: it.id, qtd, motivo });
    rondaFeitos.add(it.id); it.qtd = qtd;
    if (r.grupo) mostraUndo(r.grupo, `${motivo.replace('Ronda: ', '')}: ${qtd} × ${it.nome}`);
    if (qtd === 0) rondaItens = rondaItens.filter(x => x.id !== it.id);
    desenhaRonda();
  } catch (er) { toast(er.message, 'bad', 5000); }
});
aoEnter('rBusca', () => {
  const v = $('#rBusca').value.replace(/\D/g, ''); $('#rBusca').value = '';
  if (!v) return;
  const k = x => x.replace(/^0+/, '');
  const alvo = rondaItens.find(i => k(i.ean) === k(v) && !rondaFeitos.has(i.id)) || rondaItens.find(i => k(i.ean) === k(v));
  if (!alvo) { beep(false); toast('Este produto não estava na lista do endereço. Use “＋ Item que não estava na lista”.', 'bad', 4500); return; }
  beep(true);
  const el = $('#ri-' + alvo.id); el.classList.add('destaque'); el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => el.classList.remove('destaque'), 2500);
});
$('#rNovo').addEventListener('click', () => { $('#end').value = rondaEnd; atualizaEnd(); setTipo('CONTAGEM'); setModo('entrada'); $('#ean').focus(); });

// =====================================================================
// BAIXA
// =====================================================================
aoEnter('bEan', async () => {
  const ean = $('#bEan').value.replace(/\D/g, '');
  if (!ean) return;
  try {
    const r = await api('/api/produto/' + ean);
    if (!r.cadastrado) { beep(false); $('#bLista').innerHTML = '<p style="color:var(--bad)">EAN não cadastrado.</p>'; return; }
    window.__baixaLotes = r.lotes;
    $('#bLista').innerHTML = `<div class="prod"><b>${esc(r.produto.nome)}</b></div>` + (r.lotes.length ? r.lotes.map(l => `
      <div class="item"><div><div class="pname">lote ${esc(l.lote)}</div><div class="muted small">${addr(l.endereco, l.endereco_ok)} · ${l.qtd} un.</div></div>
      <div style="text-align:right">${pill(l.status, l.cor)}<div class="small" style="margin-top:3px">${brData(l.validade)}</div></div>
      <div class="acts"><button class="primary" data-b="${l.id}">Dar baixa</button></div></div>`).join('') : '<p class="muted">Sem estoque deste produto.</p>');
    beep(true);
  } catch (e) { toast('Não consegui consultar: ' + e.message, 'bad'); }
});
$('#bLista').addEventListener('click', async e => {
  const b = e.target.closest('button[data-b]');
  if (!b) return;
  const l = window.__baixaLotes.find(x => x.id === +b.dataset.b);
  CFG = CFG || await api('/api/config').catch(() => ({ motivos_baixa: ['Venda', 'Vencido', 'RMA Fornecedor', 'Avaria', 'Furto', 'Retirada Preventiva', 'Doação', 'Outro'] }));
  const d = await dialogo({ titulo: 'Dar baixa', sub: `lote ${l.lote} · saldo ${l.qtd}`, campos: [
    { id: 'q', label: 'Quantidade', valor: l.qtd, inputmode: 'numeric' },
    { id: 'm', label: 'Motivo', tipo: 'select', opcoes: l.dias <= 0 ? ['Vencido', ...CFG.motivos_baixa.filter(x => x !== 'Vencido')] : CFG.motivos_baixa }] });
  if (!d || !/^\d+$/.test(d.q.trim()) || +d.q < 1) return;
  try {
    const r = await lancar({ tipo: 'BAIXA', lote_id: l.id, qtd: +d.q, motivo: d.m });
    if (r.grupo) mostraUndo(r.grupo, `Baixa: ${d.q} × lote ${l.lote} (${d.m})`);
    toast('Baixa registrada', 'ok', 2000);
    $('#bEan').value = ''; $('#bLista').innerHTML = ''; $('#bEan').focus();
  } catch (er) { toast(er.message, 'bad', 5000); }
});

// =====================================================================
// BUSCA
// =====================================================================
aoEnter('sEan', async () => {
  const v = $('#sEan').value.trim();
  if (!v) return;
  try {
    const soDig = /^\d{8,14}$/.test(v);
    const lotes = soDig ? (await api('/api/produto/' + v)).lotes : (await api('/api/lotes?limite=40&q=' + encodeURIComponent(v))).itens;
    beep(true);
    $('#sLista').innerHTML = lotes.length ? lotes.map(l => `
      <div class="item"><div><div class="pname">${esc(l.nome || l.ean)}</div><div class="muted small">lote ${esc(l.lote)} · ${l.qtd} un.</div></div>
      <div style="text-align:right">${pill(l.status, l.cor)}<div class="small" style="margin-top:3px">${brData(l.validade)}</div></div>
      <div style="grid-column:1/-1"><div style="font:700 26px var(--font-display);letter-spacing:-.02em">${esc(l.endereco || 'sem endereço')}</div><div class="small muted">${esc(descEndereco(l.endereco))}</div></div></div>`).join('') : '<p class="muted">Nada encontrado em estoque.</p>';
  } catch (e) { toast('Não consegui consultar: ' + e.message, 'bad'); }
  $('#sEan').select();
});

// ---------- início ----------
inicia();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
