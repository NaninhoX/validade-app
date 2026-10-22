'use strict';
// Conferências: lista de sessões, tela de bipagem em rajada (#/conferencia/ID) e resumo automático da ronda do dia.
// As leituras vão para uma fila local (como a do coletor): aparecem na hora, seguem para o servidor em ordem e o reenvio
// nunca soma duas vezes (cada leitura leva um client_id).
const Conferencias = (() => {
  const TIPOS = {
    RECEBIMENTO: { nome: 'Recebimento', desc: 'Bipe o que chegou e some as quantidades. Só registra: não altera o estoque.' },
    VALIDADE: { nome: 'Validade', desc: 'Bipe e informe lote e validade de cada produto. Entra no estoque e na fila FEFO.' },
    CONTAGEM: { nome: 'Contagem', desc: 'Bipe e conte, com endereço opcional. Só registra: não altera o estoque.' },
    RONDA: { nome: 'Ronda do dia', desc: '' },
  };
  const nomeTipo = t => (TIPOS[t] || {}).nome || t;
  const hora = ts => (ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
  const dataBr = ts => (ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  const durTxt = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`);
  const op = () => (typeof S !== 'undefined' && S.op) || 'LOCAL';
  const pl = (n, s, p) => `${int(n)} ${n === 1 ? s : p}`;

  // ---------- fila de operações (guardada no aparelho) ----------
  const fila = () => lsGet('confFila', []);
  const salvaFila = l => lsSet('confFila', l);
  const empilha = o => { const l = fila(); l.push(o); salvaFila(l); };
  let drenando = false, ativo = null;      // ativo: estado da tela de bipagem aberta

  function pedeNome(ean) {
    return dialogo({ titulo: 'Produto novo', sub: `EAN ${ean}: informe o nome uma vez para cadastrar`, campos: [{ id: 'nome', label: 'Nome do produto' }], ok: 'Cadastrar' })
      .then(d => (d && d.nome.trim() ? d.nome.trim() : null));
  }

  async function drena() {
    if (drenando) return;
    drenando = true;
    try {
      for (;;) {
        const f = fila();
        if (!f.length) break;
        const o = f[0];
        try {
          const r = await api(o.url, { method: o.metodo, body: o.body, tentativas: 0 });
          salvaFila(fila().slice(1));
          if (ativo && ativo.id === o.conf) {
            if (r.nome && o.body && o.body.ean) { ativo.nomes[o.body.ean] = r.nome; ativo.rows.filter(x => x.ean === o.body.ean).forEach(x => { x.nome = r.nome; }); }
            if (r.item && o.metodo === 'POST' && ativo.ultimo) ativo.ultimo.total = r.item.qtd;
            if (r.avisos && r.avisos.length) toast(r.avisos.join(' · '), '', 5000);
          }
        } catch (e) {
          if (!e.status) break;                                               // sem rede: tenta de novo depois
          if (e.status === 422 && o.metodo === 'POST' && o.body && !o.body.nome) {   // EAN novo: pergunta o nome uma vez
            const nome = await pedeNome(o.body.ean);
            if (nome) { const l = fila(); l[0].body.nome = nome; salvaFila(l); continue; }
          }
          salvaFila(fila().slice(1));
          toast(e.message, 'bad', 6000);
          if (ativo && ativo.id === o.conf) ativo.sujo = true;
        }
        if (ativo) desenha();
      }
    } finally {
      drenando = false;
      if (ativo) { desenha(); if (!fila().some(o => o.conf === ativo.id)) recarrega(); }
    }
  }

  // ---------- tela de bipagem ----------
  const chaveLinha = x => [x.ean, x.lote || '', x.validade || '', x.endereco || ''].join('|');

  function paraLocal(d) {
    return d.itens.map(i => ({ cid: i.client_id || String(i.id), id: i.id, ean: i.ean, nome: i.nome, qtd: i.qtd, lote: i.lote, validade: i.validade, endereco: i.endereco, esperado: i.esperado, t: Date.parse(i.atualizado_em || i.criado_em) || 0 }));
  }

  async function recarrega() {
    if (!ativo) return;
    const id = ativo.id;
    try {
      const d = await api('/api/conferencias/' + id);
      if (!ativo || ativo.id !== id || fila().some(o => o.conf === id)) return;      // leitura nova no meio do caminho: vale a local
      ativo.c = d.conferencia; ativo.rows = paraLocal(d); ativo.sujo = false;
      desenha();
    } catch { /* offline: segue com o que tem */ }
  }

  async function burst(view, id) {
    const d = await api('/api/conferencias/' + encodeURIComponent(id));
    const c = d.conferencia;
    ativo = { id: c.id, c, rows: paraLocal(d), nomes: {}, ultimo: null, pendente: null, sujo: false };
    for (const r of ativo.rows) if (r.nome) ativo.nomes[r.ean] = r.nome;
    const editavel = c.aberta && c.tipo !== 'RONDA';
    const eVal = c.tipo === 'VALIDADE', eEnd = c.tipo === 'VALIDADE' || c.tipo === 'CONTAGEM';
    view.innerHTML = `<div class="cf cwrap" id="cf">
      <div class="card cf-head"><div class="cf-tit"><div><b>${esc(nomeTipo(c.tipo))}</b> <span class="muted">#${c.id} · ${esc(c.operador)}${c.nota ? ' · NF ' + esc(c.nota) : ''}</span></div>
        <span class="pill" id="cfEstado" style="--c:${c.aberta ? 'var(--good)' : 'var(--muted)'}">${c.aberta ? 'Aberta' : 'Fechada'}</span></div>
        <div class="cf-cont" id="cfCont" aria-live="polite"></div>
        <div class="cf-acoes">
          ${editavel ? `<button class="primary" id="cfFechar">${ico('check')} Fechar conferência</button><button class="sm subtle" id="cfApagar">Descartar</button>`
    : `<a class="btn primary" href="/conferencia?id=${c.id}" target="_blank" rel="noopener">${ico('printer')} Imprimir ou salvar em PDF</a><a class="btn" href="/api/conferencias/${c.id}.csv" download>${ico('download')} CSV</a>`}
        </div><div class="xs muted" id="cfSync"></div></div>
      ${c.tipo === 'RONDA' ? `<div class="callout" style="margin-bottom:14px">${ico('info')}<div>Resumo da ronda do dia${c.obs ? ': ' + esc(c.obs) : ''}. Mostra o que foi contado; “sistema” é o saldo antes da contagem. Somente leitura.</div></div>` : ''}
      ${editavel ? `
      ${eEnd ? `<div class="f-wrap"><label class="f" for="cfEnd">Endereço (opcional)</label><div class="in"><input id="cfEnd" autocomplete="off" autocapitalize="characters" placeholder="ex.: 3-B-2" value="${esc(c.endereco || '')}"><button class="cam" id="cfCamEnd" aria-label="Ler etiqueta do endereço">${ico('camera', 24)}</button></div></div>` : ''}
      ${c.tipo === 'RECEBIMENTO' || c.tipo === 'CONTAGEM' ? `<div class="cf-lista-nota"><button class="sm" id="cfCarrega">${ico('upload')} Carregar a lista da nota ou da contagem</button><button class="sm" id="cfChave">${ico('camera')} Bipar a chave da nota</button>
        <div class="xs muted" style="margin-top:6px">Planilha, CSV, TXT ou XML da NF-e. Cada produto fica laranja até chegar na quantidade, verde quando bate e vermelho quando passa.</div></div>` : ''}
      <div class="f-wrap"><label class="f" for="cfEan">Código de barras (EAN)</label>
        <div class="in"><input id="cfEan" inputmode="numeric" autocomplete="off" placeholder="bipe ou use a câmera"><button class="cam" id="cfCam" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div>
        <div class="xs muted" style="margin-top:6px">Cada leitura soma 1 na mesma linha. Digite <b>+12</b> e Enter para somar 12 ao último produto.</div></div>
      <div id="cfProd" class="cf-prod" hidden aria-live="polite"></div>
      ${eVal ? `<div id="cfVal" hidden>
        <div class="f-wrap"><label class="f" for="cfLote">Lote</label><input id="cfLote" autocomplete="off" autocapitalize="characters"></div>
        <div class="f-wrap"><label class="f" for="cfValid">Validade (DDMMAA, DD/MM/AAAA ou MM/AA)</label><input id="cfValid" inputmode="numeric" autocomplete="off" placeholder="ex.: 150327"><div class="xs muted" id="cfPrev" style="margin-top:6px;min-height:16px"></div></div>
        <button class="primary big" id="cfAdd">${ico('plus')} Adicionar</button></div>` : ''}` : ''}
      <div class="cf-lista-h"><h2>Lidos</h2><span class="xs muted" id="cfN"></span></div>
      <div id="cfLista"></div></div>`;

    desenha();
    const relogio = setInterval(() => { if (!document.body.contains($('#cf')) || !ativo || ativo.id !== c.id) clearInterval(relogio); else contador(); }, 20000);

    $('#cfLista').addEventListener('click', e => {
      const ed = e.target.closest('[data-ed]'), del = e.target.closest('[data-del]');
      if (ed) editaLinha(ed.dataset.ed);
      if (del) removeLinha(del.dataset.del);
    });
    if (!editavel) { drena(); return; }

    const eanIn = $('#cfEan');
    const foco = () => { if (!matchMedia('(pointer: coarse)').matches) eanIn.focus({ preventScroll: true }); };
    eanIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); entrada(eanIn.value); eanIn.value = ''; } });
    $('#cfCam').addEventListener('click', async () => {
      try { const v = await Scanner.abrir({ titulo: 'Aponte para o código de barras', aceitar: 'ean' }); if (v) entrada(v); }
      catch (er) { toast(er.message, 'bad', 6000); }
    });
    if (eEnd) {
      const en = $('#cfEnd');
      en.addEventListener('change', () => {
        const v = en.value.trim();
        if (v && !parseEndereco(v).valido) { toast('Endereço fora do padrão (ex.: 3-B-2)', 'bad'); return; }
        api('/api/conferencias/' + c.id, { method: 'PUT', body: { endereco: v, operador: op() } }).catch(() => {});
      });
      $('#cfCamEnd').addEventListener('click', async () => {
        try { const v = await Scanner.abrir({ titulo: 'Aponte para a etiqueta do endereço', aceitar: 'texto' }); if (v) { en.value = v.toUpperCase(); en.dispatchEvent(new Event('change')); eanIn.focus(); } }
        catch (er) { toast(er.message, 'bad', 6000); }
      });
    }
    if (eVal) {
      const lote = $('#cfLote'), val = $('#cfValid');
      val.addEventListener('input', () => { const p = parseData(val.value); $('#cfPrev').textContent = val.value.trim() ? (p ? brData(p) + (diasAte(p) < 0 ? ' · já vencido' : '') : 'data inválida') : ''; });
      lote.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); val.focus(); } });
      val.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmaValidade(); } });
      $('#cfAdd').addEventListener('click', confirmaValidade);
    }
    const bc = $('#cfCarrega'); if (bc) bc.addEventListener('click', () => ListaNota.abre({ conferencia: c, recarrega: async () => { ativo.sujo = true; await recarrega(); } }));
    const bk = $('#cfChave'); if (bk) bk.addEventListener('click', async () => {
      try {
        const v = await Scanner.abrir({ titulo: 'Aponte para o código de barras da nota (DANFE)', aceitar: 'chave' });
        if (!v) return;
        const nf = String(+v.slice(25, 34)), serie = String(+v.slice(22, 25));
        await api('/api/conferencias/' + c.id, { method: 'PUT', body: { nota: nf, operador: op() } });
        ativo.c.nota = nf; toast('Nota ' + nf + ' (série ' + serie + ') anotada na conferência', 'ok', 3500);
        const t = $('.cf-tit .muted'); if (t && !/NF /.test(t.textContent)) t.textContent += ' · NF ' + nf;
      } catch (er) { toast(er.message, 'bad', 6000); }
    });
    $('#cfFechar').addEventListener('click', fechar);
    $('#cfApagar').addEventListener('click', async () => {
      if (!confirm('Descartar esta conferência? As leituras dela serão apagadas' + (c.tipo === 'VALIDADE' ? ' e o que entrou no estoque por ela será estornado.' : '.'))) return;
      try { await esvazia(); await api('/api/conferencias/' + c.id, { method: 'DELETE' }); location.hash = '#/conferencias'; } catch (er) { toast(er.message, 'bad', 6000); }
    });
    foco();
    drena();
  }

  function contador() {
    if (!ativo || !$('#cfCont')) return;
    const itens = ativo.rows.reduce((s, r) => s + r.qtd, 0), eans = new Set(ativo.rows.map(r => r.ean)).size;
    const min = ativo.c.aberta ? Math.max(0, Math.round((Date.now() - Date.parse(ativo.c.aberta_em)) / 60000)) : ativo.c.minutos;
    $('#cfCont').innerHTML = `<b>${int(itens)}</b> ${itens === 1 ? 'item' : 'itens'} · <b>${eans}</b> ${eans === 1 ? 'EAN' : 'EANs'} · <b>${min}</b> min`;
  }

  function desenha() {
    if (!ativo || !$('#cfLista')) return;
    contador();
    const pend = fila().filter(o => o.conf === ativo.id).length;
    $('#cfSync').textContent = pend ? (navigator.onLine ? `Enviando ${pend}…` : `Sem conexão: ${pend} leitura(s) guardada(s) neste aparelho`) : '';
    const aberta = ativo.c.aberta && ativo.c.tipo !== 'RONDA';
    const lista = [...ativo.rows].sort((a, b) => b.t - a.t);
    const eRonda = ativo.c.tipo === 'RONDA';
    $('#cfN').textContent = lista.length ? pl(lista.length, 'linha', 'linhas') : '';
    $('#cfLista').innerHTML = lista.length ? lista.map(r => {
      const cls = r.esperado === null || r.esperado === undefined ? '' : r.qtd === r.esperado ? 'ok' : r.qtd > r.esperado ? 'mais' : 'menos';
      const diff = cls === '' ? '' : cls === 'ok' ? 'igual' : (r.qtd > r.esperado ? '+' : '−') + Math.abs(r.qtd - r.esperado);
      const partes = [r.ean, r.lote ? 'lote ' + esc(r.lote) : '', r.validade ? 'val. ' + brData(r.validade) : '', r.endereco ? esc(r.endereco) : '',
        cls ? `${eRonda ? 'sistema' : 'esperado'} ${r.esperado}${diff === 'igual' ? '' : ' (' + diff + ')'}` : ''].filter(Boolean);
      return `<div class="cf-item ${cls}">
        <div class="cf-info"><div class="cf-nome">${esc(r.nome || ativo.nomes[r.ean] || 'Produto ' + r.ean)}</div><div class="xs muted">${partes.join(' · ')}</div></div>
        ${aberta ? `<button class="cf-qtd" data-ed="${esc(r.cid)}" aria-label="Editar ${esc(r.nome || r.ean)}">${int(r.qtd)}</button><button class="icon subtle" data-del="${esc(r.cid)}" aria-label="Remover linha">${ico('x')}</button>`
    : `<div class="cf-qtd ro">${int(r.qtd)}</div>`}</div>`;
    }).join('') : '<p class="muted" style="padding:10px 2px">Nenhuma leitura ainda.</p>';
  }

  // ---------- leitura ----------
  function entrada(bruto) {
    const t = String(bruto || '').trim();
    if (!t) return;
    const m = t.match(/^\+\s*(\d{1,5})$/);
    if (m) {
      const u = ativo.ultimo;
      if (!u) { toast('Leia um produto antes de usar +N', 'bad'); return; }
      return soma({ ean: u.ean, lote: u.lote, validade: u.validade, endereco: u.endereco }, +m[1]);
    }
    const ean = t.replace(/\D/g, '');
    if (ean.length < 8 || ean.length > 14 || ean !== t) { toast('Código inválido: confira os números', 'bad'); return; }
    if (ativo.c.tipo !== 'VALIDADE') return soma({ ean }, 1);
    // validade: pede lote e validade; repetindo o EAN já vêm preenchidos com os da leitura anterior
    ativo.pendente = ean;
    const u = ativo.ultimo && ativo.ultimo.ean === ean ? ativo.ultimo : null;
    $('#cfVal').hidden = false;
    $('#cfLote').value = u ? u.lote || '' : ''; $('#cfValid').value = u ? brData(u.validade) : ''; $('#cfValid').dispatchEvent(new Event('input'));
    mostraProduto(ean, ativo.nomes[ean], null, 'Informe lote e validade');
    $('#cfLote').focus(); $('#cfLote').select();
  }

  function confirmaValidade() {
    const ean = ativo.pendente;
    if (!ean) { toast('Leia o código de barras primeiro', 'bad'); return; }
    const validade = parseData($('#cfValid').value);
    if (!validade) { toast('Validade inválida', 'bad'); $('#cfValid').focus(); return; }
    const lote = $('#cfLote').value.trim().toUpperCase() || 'S/L';
    const endereco = ($('#cfEnd') && $('#cfEnd').value.trim().toUpperCase()) || '';
    ativo.pendente = null; $('#cfVal').hidden = true; $('#cfValid').value = ''; $('#cfLote').value = '';
    soma({ ean, lote, validade, endereco }, 1);
    $('#cfEan').focus();
  }

  function mostraProduto(ean, nome, total, extra) {
    const p = $('#cfProd'); if (!p) return;
    p.hidden = false;
    p.innerHTML = `<div class="cf-prod-n">${esc(nome || 'Produto ' + ean)}</div><div class="xs muted">${ean}${total ? ` · agora ${int(total)} nesta linha` : ''}${extra ? ' · ' + esc(extra) : ''}</div>`;
  }

  // soma n à linha (ean, lote, validade, endereço): atualiza a tela na hora e manda para a fila
  function soma(k, n) {
    const a = ativo, c = a.c;
    k = { ean: k.ean, lote: c.tipo === 'VALIDADE' ? k.lote : null, validade: c.tipo === 'VALIDADE' ? k.validade : null,
      endereco: c.tipo === 'RECEBIMENTO' ? null : (k.endereco !== undefined ? (k.endereco || null) : (($('#cfEnd') && $('#cfEnd').value.trim().toUpperCase()) || null)) };
    const client_id = uuid();
    let linha = a.rows.find(r => chaveLinha(r) === chaveLinha(k));
    if (linha) { linha.qtd += n; linha.t = Date.now(); } else { linha = { cid: client_id, ...k, nome: a.nomes[k.ean] || null, qtd: n, esperado: null, t: Date.now() }; a.rows.push(linha); }
    a.ultimo = { ...k, total: linha.qtd };
    mostraProduto(k.ean, linha.nome, linha.qtd);
    empilha({ conf: a.id, metodo: 'POST', url: `/api/conferencias/${a.id}/itens`, body: { client_id, ean: k.ean, qtd: n, lote: k.lote, validade: k.validade, endereco: k.endereco || '', operador: op(), ts: new Date().toISOString() } });
    desenha();
    drena().then(() => { if (ativo && ativo.id === a.id && ativo.ultimo && ativo.ultimo.ean === k.ean) { const r = ativo.rows.find(x => chaveLinha(x) === chaveLinha(k)); mostraProduto(k.ean, (r && r.nome) || ativo.nomes[k.ean], r && r.qtd); } });
  }

  async function editaLinha(cid) {
    const a = ativo, r = a.rows.find(x => x.cid === cid);
    if (!r) return;
    const campos = [{ id: 'qtd', label: 'Quantidade', valor: r.qtd, inputmode: 'numeric' }];
    if (a.c.tipo === 'VALIDADE') campos.push({ id: 'lote', label: 'Lote', valor: r.lote || '' }, { id: 'validade', label: 'Validade', valor: brData(r.validade) });
    if (a.c.tipo !== 'RECEBIMENTO') campos.push({ id: 'endereco', label: 'Endereço (opcional)', valor: r.endereco || '' });
    const d = await dialogo({ titulo: r.nome || r.ean, sub: 'Corrigir esta linha', campos, ok: 'Salvar' });
    if (!d) return;
    const qtd = Number(d.qtd);
    if (!Number.isInteger(qtd) || qtd < 1) { toast('Quantidade inválida', 'bad'); return; }
    const body = { qtd, operador: op() };
    if (a.c.tipo === 'VALIDADE') {
      const v = parseData(d.validade); if (!v) { toast('Validade inválida', 'bad'); return; }
      body.lote = d.lote.trim().toUpperCase() || 'S/L'; body.validade = v;
    }
    if (a.c.tipo !== 'RECEBIMENTO') {
      const e = d.endereco.trim().toUpperCase();
      if (e && !parseEndereco(e).valido) { toast('Endereço fora do padrão (ex.: 3-B-2)', 'bad'); return; }
      body.endereco = e;
    }
    Object.assign(r, { qtd, lote: body.lote ?? r.lote, validade: body.validade ?? r.validade, endereco: body.endereco !== undefined ? (body.endereco || null) : r.endereco, t: Date.now() });
    empilha({ conf: a.id, metodo: 'PUT', url: `/api/conferencias/${a.id}/itens/${encodeURIComponent(cid)}`, body });
    desenha(); drena();
  }

  function removeLinha(cid) {
    const a = ativo, r = a.rows.find(x => x.cid === cid);
    if (!r || !confirm(`Remover ${r.nome || r.ean} (${r.qtd}) da conferência?`)) return;
    a.rows = a.rows.filter(x => x !== r);
    empilha({ conf: a.id, metodo: 'DELETE', url: `/api/conferencias/${a.id}/itens/${encodeURIComponent(cid)}`, body: undefined });
    desenha(); drena();
  }

  async function esvazia() {
    await drena();
    if (fila().some(o => o.conf === ativo.id)) throw new Error('Há leituras ainda não enviadas. Conecte-se à internet e tente de novo.');
  }

  async function fechar() {
    const a = ativo;
    try { await esvazia(); } catch (e) { toast(e.message, 'bad', 6000); return; }
    if (a.sujo) { await recarrega(); toast('Algumas leituras foram recusadas. Confira a lista e feche de novo.', 'bad', 6000); return; }
    const itens = a.rows.reduce((s, r) => s + r.qtd, 0), eans = new Set(a.rows.map(r => r.ean)).size;
    if (!a.rows.length) { toast('Nenhum item lido', 'bad'); return; }
    if (!confirm(`Fechar a conferência de ${nomeTipo(a.c.tipo).toLowerCase()}?\n\n${pl(itens, 'item', 'itens')} em ${pl(eans, 'EAN', 'EANs')}. Depois de fechada não dá para alterar. Você poderá imprimir a lista em ordem alfabética.`)) return;
    try {
      await api(`/api/conferencias/${a.id}/fechar`, { method: 'POST', body: { operador: op() } });
      location.href = `/conferencia?id=${a.id}`;
    } catch (e) { toast(e.message, 'bad', 6000); }
  }

  // ---------- lista ----------
  async function lista(view) {
    ativo = null;
    const f = { tipo: lsGet('confFiltroTipo', ''), data: '', operador: '' };
    const filtros = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    view.innerHTML = `<div class="cf grid" style="gap:14px">
      <div class="card" id="cfNova" hidden><div class="head"><div><h2>Nova conferência</h2><div class="sub">Escolha o tipo</div></div><button class="icon subtle" id="cfNovaX" aria-label="Fechar">${ico('x')}</button></div>
        <div class="cf-tipos" id="cfTipos">${['RECEBIMENTO', 'VALIDADE', 'CONTAGEM'].map(t => `<button class="cf-tipo" data-t="${t}" aria-pressed="false"><b>${TIPOS[t].nome}</b><span class="small muted">${TIPOS[t].desc}</span></button>`).join('')}</div>
        <div class="f-wrap" id="cfNotaW" style="margin-top:14px"><label class="f" for="cfNota">Número da NF (opcional)</label><input id="cfNota" inputmode="numeric" autocomplete="off" maxlength="40"></div>
        <button class="primary big" id="cfComecar" disabled>Começar a bipar</button></div>
      <div class="cf-barra"><button class="primary" id="cfNovo">${ico('plus')} Nova conferência</button>
        <select id="cfFTipo" aria-label="Tipo"><option value="">Todos os tipos</option>${Object.keys(TIPOS).map(t => `<option value="${t}" ${f.tipo === t ? 'selected' : ''}>${TIPOS[t].nome}</option>`).join('')}</select>
        <input type="date" id="cfFData" aria-label="Dia"><select id="cfFOp" aria-label="Operador"><option value="">Todos os operadores</option></select></div>
      <div class="card" id="cfLista2"><div class="skeleton" style="height:80px"></div></div></div>`;
    let tipoNovo = null;
    $('#cfNovo').addEventListener('click', () => { $('#cfNova').hidden = !$('#cfNova').hidden; });
    $('#cfNovaX').addEventListener('click', () => { $('#cfNova').hidden = true; });
    $('#cfTipos').addEventListener('click', e => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      tipoNovo = b.dataset.t;
      $$('#cfTipos .cf-tipo').forEach(x => x.setAttribute('aria-pressed', x === b));
      $('#cfComecar').disabled = false;
      $('#cfNotaW').hidden = tipoNovo !== 'RECEBIMENTO' && tipoNovo !== 'VALIDADE' && tipoNovo !== 'CONTAGEM';
    });
    $('#cfComecar').addEventListener('click', async () => {
      if (!tipoNovo) return;
      $('#cfComecar').disabled = true;
      try {
        const c = await api('/api/conferencias', { method: 'POST', body: { tipo: tipoNovo, nota: $('#cfNota').value.trim(), client_id: uuid(), operador: op() } });
        location.hash = '#/conferencia/' + c.id;
      } catch (e) { toast(e.message, 'bad', 5000); $('#cfComecar').disabled = false; }
    });
    const ops = new Set([...(S.ops || []), op()].filter(Boolean).map(x => String(x).toUpperCase()));
    const carrega = async () => {
      const rows = await api('/api/conferencias?' + filtros());
      rows.forEach(r => ops.add(String(r.operador).toUpperCase()));
      const sel = $('#cfFOp'); sel.innerHTML = '<option value="">Todos os operadores</option>' + [...ops].sort().map(o => `<option ${f.operador === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
      $('#cfLista2').innerHTML = rows.length ? rows.map(c => `<a class="row click cf-row" href="#/conferencia/${c.id}" style="color:inherit">
          <span class="pill" style="--c:${c.aberta ? 'var(--good)' : 'var(--muted)'}">${c.aberta ? 'Aberta' : 'Fechada'}</span>
          <div><div class="pname"><b>${esc(nomeTipo(c.tipo))}</b> <span class="muted">· ${esc(c.operador)}${c.nota ? ' · NF ' + esc(c.nota) : ''}</span></div>
            <div class="xs muted">${dataBr(c.aberta_em)} · ${hora(c.aberta_em)}${c.fechada_em ? ' às ' + hora(c.fechada_em) : ''} · ${durTxt(c.minutos)}</div></div>
          <div style="text-align:right"><b class="num">${int(c.itens)}</b> <span class="xs muted">itens</span><div class="xs muted">${pl(c.eans, 'EAN', 'EANs')}</div></div></a>`).join('')
        : '<p class="muted">Nenhuma conferência encontrada.</p>';
    };
    $('#cfFTipo').addEventListener('change', e => { f.tipo = e.target.value; lsSet('confFiltroTipo', f.tipo); carrega(); });
    $('#cfFData').addEventListener('change', e => { f.data = e.target.value; carrega(); });
    $('#cfFOp').addEventListener('change', e => { f.operador = e.target.value; carrega(); });
    await carrega();
  }

  // ---------- cartão "Hoje" da Visão geral ----------
  async function cartaoHoje(el) {
    if (!el) return;
    try {
      const h = await api('/api/conferencias/hoje');
      const cel = (n, rot, href) => `<a class="hoje-c" href="${href}"><b class="num">${int(n)}</b><span class="xs muted">${rot}</span></a>`;
      el.innerHTML = `<div class="card reveal"><div class="head"><h2>Hoje</h2><span class="sub">o que já foi feito no dia</span></div>
        <div class="hoje">${cel(h.rondas, h.rondas === 1 ? 'ronda' : 'rondas', '#/coletor')}${cel(h.conferencias, h.conferencias === 1 ? 'conferência' : 'conferências', '#/conferencias')}${cel(h.auditorias, h.auditorias === 1 ? 'auditoria' : 'auditorias', '#/coletor')}</div>
        ${h.abertas ? `<div class="xs muted" style="margin-top:8px">${pl(h.abertas, 'conferência aberta', 'conferências abertas')} · <a href="#/conferencias">ver</a></div>` : ''}</div>`;
    } catch { el.innerHTML = ''; }
  }

  // ---------- ronda do dia: o coletor chama ao encerrar o turno ----------
  const rondasPend = () => lsGet('confRondas', []);
  let enviandoRondas = false;
  async function enviaRondas() {
    if (enviandoRondas) return;
    enviandoRondas = true;
    try {
      for (const b of rondasPend()) {
        try { await api('/api/conferencias/ronda', { method: 'POST', body: b, tentativas: 0 }); lsSet('confRondas', rondasPend().filter(x => x.client_id !== b.client_id)); }
        catch (e) { if (e.status) lsSet('confRondas', rondasPend().filter(x => x.client_id !== b.client_id)); else break; }
      }
    } finally { enviandoRondas = false; }
  }
  function registrarRonda(turno, operador) {
    if (!turno || !turno.fim) return;
    const client_id = 'turno-' + turno.criado;
    if (rondasPend().some(x => x.client_id === client_id)) return enviaRondas();
    lsSet('confRondas', [...rondasPend(), { client_id, inicio: turno.criado, fim: turno.fim, feitos: turno.itens.filter(i => i.feito).length, total: turno.n, operador }]);
    return enviaRondas();
  }
  window.addEventListener('online', () => { enviaRondas(); drena(); });
  setInterval(() => { enviaRondas(); if (fila().length) drena(); }, 20000);
  setTimeout(() => { enviaRondas(); if (fila().length) drena(); }, 3000);

  return { burst, lista, cartaoHoje, registrarRonda };
})();
