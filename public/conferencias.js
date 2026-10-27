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
  const estadoTxt = c => (c.aberta ? 'Aberta' : c.tipo === 'RONDA' ? 'Fechada' : c.processada ? 'Processada' : 'Finalizada');
  const estadoCor = c => (c.aberta ? 'var(--good)' : c.tipo === 'RONDA' ? 'var(--muted)' : c.processada ? 'var(--accent)' : 'var(--warn)');
  let drenando = false, ativo = null;      // ativo: estado da tela de bipagem aberta
  let cameraAberta = false;                 // com a câmera contínua aberta o nome de produto novo só é pedido depois
  const ehLocal = id => String(id).startsWith('L');
  const mapaIds = () => lsGet('confMapa', {});
  const idServidor = id => (ehLocal(id) ? mapaIds()[id] || null : id);
  const temPend = id => fila().some(o => String(o.conf) === String(id));
  const nomeDe = ean => (ativo && ativo.nomes[ean]) || (Catalogo.get(ean) || {}).nome || null;
  // leituras de produto sem cadastro e leituras recusadas ficam guardadas à parte: nunca travam as leituras seguintes nem se perdem
  const pendCad = () => lsGet('confPendCad', []);
  const salvaPendCad = l => lsSet('confPendCad', l);
  const recusadas = () => lsGet('confRecusadas', []);
  const salvaRecusadas = l => lsSet('confRecusadas', l);
  const pendDe = id => pendCad().filter(o => String(o.conf) === String(id));

  // guarda a conferência aberta no aparelho (rascunho e índice): é o que deixa abrir, bipar e finalizar sem internet
  function salvaCache() {
    const a = ativo; if (!a) return;
    lsSet('confCache:' + a.id, { c: a.c, rows: a.rows, nomes: a.nomes });
    const itens = a.rows.reduce((s, r) => s + r.qtd, 0);
    const ix = lsGet('confIndex', []).filter(x => String(x.id) !== String(a.id));
    ix.unshift({ id: a.id, tipo: a.c.tipo, operador: a.c.operador, nota: a.c.nota, aberta_em: a.c.aberta_em, fechada_em: a.c.fechada_em || null, itens, eans: new Set(a.rows.map(r => r.ean)).size, linhas: a.rows.length,
      minutos: a.c.fechada_em ? Math.max(0, Math.round((Date.parse(a.c.fechada_em) - Date.parse(a.c.aberta_em)) / 60000)) : 0, aberta: !a.c.fechada_em, processada: !!a.c.processada });
    lsSet('confIndex', ix.slice(0, 40));
  }

  // editar ou remover uma leitura que ainda espera cadastro acontece na própria lista de espera (o servidor ainda não a conhece)
  function aplicaNaPend(o) {
    if (o.metodo === 'POST') return false;
    const cid = decodeURIComponent(String(o.url).split('/').pop());
    const l = pendCad(), i = l.findIndex(x => String(x.conf) === String(o.conf) && x.body && x.body.client_id === cid);
    if (i < 0) return false;
    if (o.metodo === 'DELETE') l.splice(i, 1);
    else for (const k of ['qtd', 'lote', 'validade', 'endereco']) if (o.body && o.body[k] !== undefined) l[i].body[k] = o.body[k];
    salvaPendCad(l);
    return true;
  }

  async function drena() {
    if (drenando) return;
    drenando = true;
    try {
      for (;;) {
        const f = fila();
        if (!f.length) break;
        const o = f[0];
        if (aplicaNaPend(o)) { salvaFila(fila().slice(1)); continue; }
        let url = o.url;
        if (ehLocal(o.conf) && !o.criar) {
          const sid = mapaIds()[o.conf];
          if (!sid) { salvaFila(fila().slice(1)); continue; }               // a criação foi recusada: descarta o que dependia dela
          url = url.replace('/conferencias/' + o.conf, '/conferencias/' + sid);
        }
        try {
          const r = await api(url, { method: o.metodo, body: o.body, tentativas: 0 });
          if (o.criar) { const m = mapaIds(); m[o.conf] = r.id; lsSet('confMapa', m); }
          salvaFila(fila().slice(1));
          if (ativo && ativo.id === o.conf) {
            if (r.nome && o.body && o.body.ean) { ativo.nomes[o.body.ean] = r.nome; ativo.rows.filter(x => x.ean === o.body.ean).forEach(x => { x.nome = r.nome; }); }
            if (r.item && o.metodo === 'POST' && ativo.ultimo) ativo.ultimo.total = r.item.qtd;
            if (r.avisos && r.avisos.length) toast(r.avisos.join(' · '), '', 5000);
          }
        } catch (e) {
          if (!e.status) break;                                               // sem rede: tenta de novo depois
          salvaFila(fila().slice(1));
          if (e.status === 422 && o.metodo === 'POST' && o.body && !o.body.nome) {   // EAN novo: sai da fila (não trava as seguintes) e espera o cadastro
            const l = pendCad(); l.push(o); salvaPendCad(l);
          } else {
            const l = recusadas(); l.push({ o, motivo: e.message, em: Date.now() }); salvaRecusadas(l);
            toast(e.message, 'bad', 6000);
          }
          if (ativo && ativo.id === o.conf) ativo.sujo = true;
        }
        if (ativo) desenha();
      }
    } finally {
      drenando = false;
      if (ativo) {
        desenha();
        if (ehLocal(ativo.id) && idServidor(ativo.id) && !temPend(ativo.id)) { location.hash = '#/conferencia/' + idServidor(ativo.id); return; }   // subiu: segue pela conferência do servidor
        if (!temPend(ativo.id) && !ehLocal(ativo.id)) recarrega();
      }
    }
  }

  // cadastrar na hora os produtos novos lidos nesta conferência (ou ligar ao produto certo) e mandar as leituras de novo
  async function cadastraPendentes() {
    const a = ativo;
    if (!a) return;
    for (const ean of [...new Set(pendDe(a.id).map(o => o.body.ean))]) {
      const r = await CadProduto.abre({ ean });
      if (!r) continue;
      try {
        let ean2 = ean;
        if (r.tipo === 'mesmo') await api('/api/produtos/vincular', { method: 'POST', body: { de: ean, para: r.para, alias: true } });
        else if (r.tipo === 'erro') ean2 = r.para;
        const resto = [];
        for (const o of pendCad()) {
          if (String(o.conf) !== String(a.id) || o.body.ean !== ean) { resto.push(o); continue; }
          if (r.tipo === 'novo') Object.assign(o.body, { nome: r.nome, marca: r.marca, preco: r.preco });
          o.body.ean = ean2; empilha(o);
        }
        salvaPendCad(resto);
        const nome = r.nome || null;
        a.rows.filter(x => x.ean === ean).forEach(x => { x.ean = ean2; if (nome) x.nome = nome; });
        if (nome) a.nomes[ean2] = nome;
      } catch (e) { toast(e.message, 'bad', 6000); }
    }
    await drena();
    if (ativo === a) { desenha(); if (!pendDe(a.id).length && !recusadas().some(x => String(x.o.conf) === String(a.id))) recarrega(); }
  }
  const tentaRecusadas = () => { const a = ativo; if (!a) return; const resto = []; for (const x of recusadas()) { if (String(x.o.conf) === String(a.id)) empilha(x.o); else resto.push(x); } salvaRecusadas(resto); drena(); };
  const descartaRecusadas = () => { const a = ativo; if (!a) return; salvaRecusadas(recusadas().filter(x => String(x.o.conf) !== String(a.id))); a.sujo = true; desenha(); recarrega(); };
  function alertas() {
    const el = $('#cfAlertas');
    if (!el || !ativo) return;
    const pc = pendDe(ativo.id), rc = recusadas().filter(x => String(x.o.conf) === String(ativo.id)), eans = new Set(pc.map(o => o.body.ean)).size;
    el.innerHTML = (pc.length ? `<div class="callout warn" style="margin-bottom:12px">${ico('alert')}<div><b>${pl(eans, 'produto sem cadastro', 'produtos sem cadastro')}</b> (${pl(pc.length, 'leitura', 'leituras')}). Enquanto não forem cadastrados, ${ativo.c.tipo === 'VALIDADE' ? 'nada disso entra no estoque' : 'a leitura não é registrada'}.<div style="margin-top:8px"><button class="sm primary" id="cfCad">Cadastrar agora</button></div></div></div>` : '')
      + (rc.length ? `<div class="callout warn" style="margin-bottom:12px">${ico('alert')}<div><b>${pl(rc.length, 'leitura recusada', 'leituras recusadas')}</b>: ${esc([...new Set(rc.map(x => x.motivo))].join(' · '))}.<div style="margin-top:8px"><button class="sm" id="cfRetry">Tentar de novo</button> <button class="sm subtle" id="cfDescarta">Descartar</button></div></div></div>` : '');
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
    let c, rows, nomes = {}, offlineAgora = false;
    const rasc = lsGet('confCache:' + id, null);
    if (ehLocal(id)) {
      const sid = mapaIds()[id];
      if (sid && !temPend(id)) { location.hash = '#/conferencia/' + sid; return; }
      if (!rasc) throw new Error('Esta conferência não está mais neste aparelho.');
      ({ c, rows } = rasc); nomes = rasc.nomes || {}; offlineAgora = true;
    } else if (rasc && temPend(id)) {                                    // há leituras ainda não enviadas: vale o rascunho, que as tem
      ({ c, rows } = rasc); nomes = rasc.nomes || {};
    } else {
      try { const d = await api('/api/conferencias/' + encodeURIComponent(id)); c = d.conferencia; rows = paraLocal(d); }
      catch (e) { if (!e.rede || !rasc) throw e; ({ c, rows } = rasc); nomes = rasc.nomes || {}; offlineAgora = true; }
    }
    ativo = { id: c.id, c, rows, nomes, ultimo: null, pendente: null, sujo: false, histo: [] };
    if (offlineAgora) toast('Sem conexão: o que você bipar fica neste aparelho e sobe quando a internet voltar.', '', 5000);
    for (const r of ativo.rows) if (r.nome) ativo.nomes[r.ean] = r.nome;
    for (const r of ativo.rows) if (!r.nome) r.nome = nomeDe(r.ean);
    const editavel = c.aberta && c.tipo !== 'RONDA';
    const eVal = c.tipo === 'VALIDADE', eEnd = c.tipo === 'VALIDADE' || c.tipo === 'CONTAGEM';
    view.innerHTML = `<div class="cf cwrap" id="cf">
      <div class="card cf-head"><div class="cf-tit"><div><b>${esc(nomeTipo(c.tipo))}</b> <span class="muted">#${c.id} · ${esc(c.operador)}${c.nota ? ' · NF ' + esc(c.nota) : ''}</span></div>
        <span class="pill" id="cfEstado" style="--c:${estadoCor(c)}">${estadoTxt(c)}</span></div>
        <div class="cf-cont" id="cfCont" aria-live="polite"></div>
        <div class="cf-acoes">
          ${editavel ? `<button class="primary" id="cfFechar">${ico('check')} Fechar conferência</button><button class="sm subtle" id="cfApagar">Descartar</button>`
    : `<a class="btn primary" href="/conferencia?id=${c.id}" target="_blank" rel="noopener">${ico('printer')} Imprimir ou salvar em PDF</a><a class="btn" href="/api/conferencias/${c.id}.csv" download>${ico('download')} CSV</a><a class="btn" href="/api/conferencias/${c.id}.txt" download title="Primeira linha em branco e EAN;quantidade em cada linha, para o Importar de coletor do sistema da loja">TXT para o sistema da loja</a>${c.tipo !== 'RONDA' && !c.processada ? `<button id="cfProc">${ico('check')} Marcar como processada</button>` : ''}`}
        </div><div class="xs muted" id="cfSync">${c.processada ? `Processada${c.processada_por ? ' por ' + esc(c.processada_por) : ''} em ${dataBr(c.processada_em)} às ${hora(c.processada_em)}${c.min_ate_processar !== null ? ' (' + durTxt(c.min_ate_processar) + ' depois de finalizar)' : ''}` : ''}</div></div>
      <div id="cfAlertas"></div>
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
      <div class="cf-lista-h"><h2>Lidos</h2><span class="xs muted" id="cfN"></span>${editavel ? `<button class="sm" id="cfDes" style="margin-left:auto">${ico('undo')} Desfazer última leitura</button>` : ''}</div>
      <div id="cfLista"></div></div>`;

    desenha();
    const relogio = setInterval(() => { if (!document.body.contains($('#cf')) || !ativo || ativo.id !== c.id) clearInterval(relogio); else contador(); }, 20000);

    $('#cfLista').addEventListener('click', e => {
      const ed = e.target.closest('[data-ed]'), del = e.target.closest('[data-del]');
      if (ed) editaLinha(ed.dataset.ed);
      if (del) removeLinha(del.dataset.del);
    });
    $('#cfAlertas').addEventListener('click', e => {
      if (e.target.closest('#cfCad')) cadastraPendentes();
      else if (e.target.closest('#cfRetry')) tentaRecusadas();
      else if (e.target.closest('#cfDescarta')) descartaRecusadas();
    });
    const pr = $('#cfProc');
    if (pr) pr.addEventListener('click', async () => {
      if (!confirm('Confirma que esta conferência já foi lançada (processada) no sistema da loja?')) return;
      try { await api('/api/conferencias/' + c.id + '/processar', { method: 'POST', body: { operador: op() } }); toast('Marcada como processada', 'ok', 2500); burst(view, c.id); }
      catch (er) { toast(er.message, 'bad', 6000); }
    });
    if (!editavel) { drena(); return; }

    const eanIn = $('#cfEan');
    const foco = () => { if (!matchMedia('(pointer: coarse)').matches) eanIn.focus({ preventScroll: true }); };
    eanIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); entrada(eanIn.value); eanIn.value = ''; } });
    $('#cfCam').addEventListener('click', () => camera());
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
    const bd = $('#cfDes'); if (bd) bd.addEventListener('click', desfaz);
    $('#cfApagar').addEventListener('click', async () => {
      if (!confirm('Descartar esta conferência? As leituras dela serão apagadas' + (c.tipo === 'VALIDADE' ? ' e o que entrou no estoque por ela será estornado.' : '.'))) return;
      try { if (ehLocal(c.id) && !idServidor(c.id)) { salvaFila(fila().filter(o => String(o.conf) !== String(c.id))); localStorage.removeItem('confCache:' + c.id); lsSet('confIndex', lsGet('confIndex', []).filter(x => String(x.id) !== String(c.id))); location.hash = '#/conferencias'; return; } await esvazia(); await api('/api/conferencias/' + c.id, { method: 'DELETE' }); location.hash = '#/conferencias'; } catch (er) { toast(er.message, 'bad', 6000); }
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
    salvaCache();
    contador();
    const pend = fila().filter(o => o.conf === ativo.id).length;
    alertas();
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
    if (ean !== t || ean.length < 4 || ean.length > 14) { toast('Código inválido: confira os números', 'bad'); return; }
    if (ean.length < 8) return achaPeloFinal(ean);                       // o "macete" da loja: só os últimos dígitos do código
    if (ativo.c.tipo !== 'VALIDADE') return soma({ ean }, 1);
    // validade: pede lote e validade; repetindo o EAN já vêm preenchidos com os da leitura anterior
    ativo.pendente = ean;
    const u = ativo.ultimo && ativo.ultimo.ean === ean ? ativo.ultimo : null;
    $('#cfVal').hidden = false;
    $('#cfLote').value = u ? u.lote || '' : ''; $('#cfValid').value = u ? brData(u.validade) : ''; $('#cfValid').dispatchEvent(new Event('input'));
    mostraProduto(ean, nomeDe(ean), null, 'Informe lote e validade');
    $('#cfLote').focus(); $('#cfLote').select();
  }

  async function achaPeloFinal(d) {
    const r = (await CadProduto.procura(d)) || [];
    if (!r.length) { toast('Nenhum produto com código terminado em ' + d, 'bad', 3500); return; }
    const p = r.length === 1 && d.length >= 6 ? r[0] : await CadProduto.escolher(r, { titulo: 'Qual é o produto?', sub: 'Código terminado em ' + d });
    if (p) { ativo.nomes[p.ean] = p.nome; entrada(p.ean); }
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
    if (linha) { linha.qtd += n; linha.t = Date.now(); } else { linha = { cid: client_id, ...k, nome: nomeDe(k.ean), qtd: n, esperado: null, t: Date.now() }; a.rows.push(linha); }
    a.ultimo = { ...k, total: linha.qtd };
    (a.histo = a.histo || []).push({ k, n });
    mostraProduto(k.ean, linha.nome, linha.qtd);
    empilha({ conf: a.id, metodo: 'POST', url: `/api/conferencias/${a.id}/itens`, body: { client_id, ean: k.ean, qtd: n, lote: k.lote, validade: k.validade, endereco: k.endereco || '', operador: op(), ts: new Date().toISOString() } });
    desenha();
    drena().then(() => { if (ativo && ativo.id === a.id && ativo.ultimo && ativo.ultimo.ean === k.ean) { const r = ativo.rows.find(x => chaveLinha(x) === chaveLinha(k)); mostraProduto(k.ean, (r && r.nome) || ativo.nomes[k.ean], r && r.qtd); } });
  }

  function desfaz() {
    const a = ativo; if (!a || !a.c.aberta) return false;
    const h = (a.histo || []).pop();
    if (!h) { toast('Não há leitura para desfazer neste aparelho', 'bad', 2500); return false; }
    const linha = a.rows.find(r => chaveLinha(r) === chaveLinha(h.k));
    if (!linha) return false;
    const nova = linha.qtd - h.n;
    if (nova <= 0) { a.rows = a.rows.filter(x => x !== linha); empilha({ conf: a.id, metodo: 'DELETE', url: `/api/conferencias/${a.id}/itens/${encodeURIComponent(linha.cid)}`, body: undefined }); }
    else { linha.qtd = nova; linha.t = Date.now(); empilha({ conf: a.id, metodo: 'PUT', url: `/api/conferencias/${a.id}/itens/${encodeURIComponent(linha.cid)}`, body: { qtd: nova, operador: op() } }); }
    const ant = a.histo[a.histo.length - 1];
    const l2 = ant && a.rows.find(r => chaveLinha(r) === chaveLinha(ant.k));
    a.ultimo = l2 ? { ...ant.k, total: l2.qtd } : null;
    desenha(); drena();
    return true;
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
    const itens = a.rows.reduce((s, r) => s + r.qtd, 0), eans = new Set(a.rows.map(r => r.ean)).size;
    if (!a.rows.length && !pendDe(a.id).length) { toast('Nenhum item lido', 'bad'); return; }
    if (pendDe(a.id).length) {
      if (confirm(`Há ${pendDe(a.id).length} leitura(s) de produto(s) sem cadastro que ainda NÃO foram registradas.\n\nCadastrar agora?`)) await cadastraPendentes();
      if (pendDe(a.id).length && !confirm('Ainda há leituras sem cadastro. Fechar mesmo assim? Elas não serão registradas.')) return;
    }
    if (!confirm(`Fechar a conferência de ${nomeTipo(a.c.tipo).toLowerCase()}?\n\n${pl(itens, 'item', 'itens')} em ${pl(eans, 'EAN', 'EANs')}. Depois de fechada não dá para alterar. Você poderá imprimir a lista em ordem alfabética.`)) return;
    if (navigator.onLine) {
      await drena();
      if (a.sujo) { await recarrega(); toast('Algumas leituras foram recusadas. Confira a lista e feche de novo.', 'bad', 6000); return; }
    }
    const ts = new Date().toISOString();
    empilha({ conf: a.id, metodo: 'POST', url: `/api/conferencias/${a.id}/fechar`, body: { operador: op(), ts } });
    a.c.fechada_em = ts; a.c.aberta = false; salvaCache();
    await drena();
    if (!temPend(a.id) && idServidor(a.id)) { location.href = `/conferencia?id=${idServidor(a.id)}`; return; }
    toast('Conferência finalizada neste aparelho. Ela sobe quando a internet voltar.', 'ok', 7000);
    location.hash = '#/conferencias';
  }

  // ---------- câmera contínua: lê um código atrás do outro, com a lista numa gaveta por cima da imagem ----------
  async function camera() {
    const a = ativo, tipo = a.c.tipo;
    let g = null, ctl = null;
    const pedeQtd = () => !!lsGet('confPedeQtd', false);
    const cor = r => (r.esperado === null || r.esperado === undefined ? '' : r.qtd === r.esperado ? 'ok' : r.qtd > r.esperado ? 'mais' : 'menos');

    const resumo = () => {
      const itens = a.rows.reduce((s, r) => s + r.qtd, 0), eans = new Set(a.rows.map(r => r.ean)).size, u = a.ultimo;
      const lin = u && a.rows.find(r => chaveLinha(r) === chaveLinha(u));
      $('#gavU', g).textContent = lin ? `${lin.nome || 'Produto ' + lin.ean} · ${int(lin.qtd)}${lin.esperado != null ? ' de ' + int(lin.esperado) : ''}` : 'Leia o primeiro código';
      $('#gavT', g).textContent = `${int(itens)} itens · ${eans} EANs`;
      g.classList.toggle('ok', !!lin && cor(lin) === 'ok'); g.classList.toggle('mais', !!lin && cor(lin) === 'mais'); g.classList.toggle('menos', !!lin && cor(lin) === 'menos');
      $('#gavDes', g).disabled = !(a.histo || []).length;
      if (!$('#gavC', g).hidden) lista();
    };
    const lista = () => {
      const l = [...a.rows].sort((x, y) => y.t - x.t);
      $('#gavL', g).innerHTML = l.length ? l.map(r => `<button class="gi ${cor(r)}" data-c="${esc(r.cid)}"><span><b>${esc(r.nome || 'Produto ' + r.ean)}</b><small>${esc([r.ean, r.lote ? 'lote ' + r.lote : '', r.validade ? brData(r.validade) : '', r.esperado != null ? 'esperado ' + r.esperado : ''].filter(Boolean).join(' · '))}</small></span><em>${int(r.qtd)}</em></button>`).join('') : '<p class="gav-vazio">Nenhuma leitura ainda.</p>';
    };
    const abreForm = (html, aoOk, aoCancelar) => {
      ctl.pausa();
      const f = $('#gavF', g); f.hidden = false; f.innerHTML = html;
      const fecha = () => { f.hidden = true; f.innerHTML = ''; ctl.retoma(); };
      const ok = () => { if (aoOk(f) !== false) fecha(); };
      f.querySelector('[data-ok]').addEventListener('click', ok);
      f.querySelector('[data-x]').addEventListener('click', () => { fecha(); if (aoCancelar) aoCancelar(); });
      f.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
      return f;
    };
    const confirma = (nome, ean) => { ctl.beep(true); resumo(); g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash'); };

    const aoLer = ean => {
      const nome = nomeDe(ean);
      if (!nome && Catalogo.tamanho() > 0) {                 // não está no catálogo do aparelho: quase sempre é leitura errada
        ctl.beep(false);
        const sug = Catalogo.porFinal(ean, 3);                  // mesmos últimos 6 dígitos: pode ser o mesmo produto com o código lido errado
        const f = abreForm(`<div class="gav-fn">Código não encontrado<small>${ean}</small></div><p class="gav-aviso">Pode ser leitura errada. Aponte de novo, ou confirme se é um produto novo.</p>
          ${sug.length ? `<div class="gav-sug"><small>Parece com:</small>${sug.map((s, i) => `<button type="button" data-sug="${i}">${esc((s.nome || s.ean).slice(0, 44))}</button>`).join('')}</div>` : ''}
          <div class="gav-fb"><button data-x>Ler de novo</button><button class="primary" data-ok>É produto novo</button></div>`, () => { processa(ean, null); }, () => {});
        f.querySelectorAll('[data-sug]').forEach(b => b.addEventListener('click', () => { const s = sug[+b.dataset.sug]; f.querySelector('[data-x]').click(); ativo.nomes[s.ean] = s.nome; processa(s.ean, s.nome); }));
        return;
      }
      processa(ean, nome);
    };
    const processa = (ean, nome) => {
      if (tipo === 'VALIDADE') {
        const u = a.ultimo && a.ultimo.ean === ean ? a.ultimo : null;
        const f = abreForm(`<div class="gav-fn">${esc(nome || 'Produto ' + ean)}<small>${ean}${nome ? '' : ' · ainda sem nome neste aparelho'}</small></div>
          <div class="gav-fc"><label>Lote<input id="gfL" autocomplete="off" autocapitalize="characters" value="${esc(u ? u.lote || '' : '')}"></label>
          <label>Validade<input id="gfV" inputmode="numeric" autocomplete="off" placeholder="150327" value="${u && u.validade ? brData(u.validade) : ''}"></label>
          <label>Qtd<input id="gfQ" inputmode="numeric" autocomplete="off" value="1"></label></div>
          <div class="gav-fp" id="gfP"></div>
          <div class="gav-fb"><button data-x>Cancelar</button><button class="primary" data-ok>Adicionar</button></div>`,
          form => {
            const validade = parseData($('#gfV', form).value), qtd = Number($('#gfQ', form).value);
            if (!validade) { toast('Validade inválida (ex.: 150327)', 'bad', 2500); $('#gfV', form).focus(); return false; }
            if (!Number.isInteger(qtd) || qtd < 1) { toast('Quantidade inválida', 'bad', 2500); return false; }
            soma({ ean, lote: $('#gfL', form).value.trim().toUpperCase() || 'S/L', validade, endereco: ($('#cfEnd') && $('#cfEnd').value.trim().toUpperCase()) || '' }, qtd);
            confirma(nome, ean);
          }, () => {});
        const v = $('#gfV', f); v.addEventListener('input', () => { const p = parseData(v.value); $('#gfP', f).textContent = v.value.trim() ? (p ? brData(p) + (diasAte(p) < 0 ? ' · já vencido' : '') : 'data inválida') : ''; });
        ($('#gfL', f).value ? $('#gfV', f) : $('#gfL', f)).focus();
        return;
      }
      if (pedeQtd()) {
        const f = abreForm(`<div class="gav-fn">${esc(nome || 'Produto ' + ean)}<small>${ean}</small></div>
          <div class="gav-q">${[1, 2, 3, 5, 6, 10, 12, 20].map(n => `<button type="button" data-n="${n}">${n}</button>`).join('')}</div>
          <div class="gav-fc"><label>Quantidade<input id="gfQ" inputmode="numeric" autocomplete="off" value="1"></label></div>
          <div class="gav-fb"><button data-x>Cancelar</button><button class="primary" data-ok>Adicionar</button></div>`,
          form => { const qtd = Number($('#gfQ', form).value); if (!Number.isInteger(qtd) || qtd < 1) { toast('Quantidade inválida', 'bad', 2500); return false; } soma({ ean }, qtd); confirma(nome, ean); }, () => {});
        f.querySelectorAll('[data-n]').forEach(b => b.addEventListener('click', () => { $('#gfQ', f).value = b.dataset.n; f.querySelector('[data-ok]').click(); }));
        $('#gfQ', f).focus(); $('#gfQ', f).select();
        return;
      }
      soma({ ean }, 1); confirma(nome, ean);
    };

    const montar = c2 => {
      ctl = c2;
      g = document.createElement('div');
      g.className = 'gav';
      g.innerHTML = `<div class="gav-bar"><button class="gav-abre" id="gavAbre" aria-expanded="false" aria-controls="gavC"><span class="gav-u" id="gavU"></span><span class="gav-t" id="gavT"></span><span class="gav-seta">${ico('chevron')}</span></button>
          <button class="gav-des" id="gavDes" aria-label="Desfazer última leitura">${ico('undo')}</button></div>
        <div class="gav-corpo" id="gavC" hidden>
          <div class="gav-op"><div class="seg" role="group" aria-label="Quantidade por leitura"><button id="gavUm" aria-pressed="${!pedeQtd()}">Somar 1</button><button id="gavPed" aria-pressed="${pedeQtd()}">Perguntar qtd</button></div></div>
          <div class="gav-mais"><span>Somar ao último:</span>${[2, 5, 10, 12].map(n => `<button data-mais="${n}">+${n}</button>`).join('')}</div>
          <div class="gav-lista" id="gavL"></div>
        </div>
        <div class="gav-form" id="gavF" hidden></div>`;
      c2.ov.appendChild(g);
      $('#gavAbre', g).addEventListener('click', () => { const c3 = $('#gavC', g), abre = c3.hidden; c3.hidden = !abre; $('#gavAbre', g).setAttribute('aria-expanded', abre); g.classList.toggle('aberta', abre); if (abre) lista(); });
      $('#gavDes', g).addEventListener('click', () => { if (desfaz()) { ctl.beep(false); resumo(); } });
      $('#gavUm', g).addEventListener('click', () => { lsSet('confPedeQtd', false); $('#gavUm', g).setAttribute('aria-pressed', 'true'); $('#gavPed', g).setAttribute('aria-pressed', 'false'); });
      $('#gavPed', g).addEventListener('click', () => { lsSet('confPedeQtd', true); $('#gavUm', g).setAttribute('aria-pressed', 'false'); $('#gavPed', g).setAttribute('aria-pressed', 'true'); });
      g.addEventListener('click', e => {
        const m = e.target.closest('[data-mais]');
        if (m) { if (!a.ultimo) { toast('Leia um produto antes', 'bad', 2000); return; } soma({ ean: a.ultimo.ean, lote: a.ultimo.lote, validade: a.ultimo.validade, endereco: a.ultimo.endereco }, +m.dataset.mais); confirma(); return; }
        const gi = e.target.closest('.gi');
        if (gi) {
          const r = a.rows.find(x => x.cid === gi.dataset.c); if (!r) return;
          abreForm(`<div class="gav-fn">${esc(r.nome || r.ean)}<small>corrigir a quantidade desta linha</small></div><div class="gav-fc"><label>Quantidade<input id="gfQ" inputmode="numeric" value="${r.qtd}"></label></div><div class="gav-fb"><button data-x>Cancelar</button><button class="primary" data-ok>Salvar</button></div>`,
            form => {
              const q = Number($('#gfQ', form).value); if (!Number.isInteger(q) || q < 1) { toast('Quantidade inválida', 'bad', 2500); return false; }
              r.qtd = q; r.t = Date.now(); a.histo = []; empilha({ conf: a.id, metodo: 'PUT', url: `/api/conferencias/${a.id}/itens/${encodeURIComponent(r.cid)}`, body: { qtd: q, operador: op() } }); desenha(); drena(); resumo();
            }, () => {});
          $('#gfQ', g).focus(); $('#gfQ', g).select();
        }
      });
      resumo();
    };

    cameraAberta = true;
    try { await Scanner.abrir({ titulo: nomeTipo(tipo), aceitar: 'ean', continuo: { montar, aoLer } }); }
    catch (er) { toast(er.message, 'bad', 6000); }
    finally { cameraAberta = false; desenha(); drena().then(() => { if (ativo && ativo.id === a.id && pendDe(a.id).length) cadastraPendentes(); }); }
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
      <div class="off-prep"><button class="sm" id="offPrepC">${ico('download')} Preparar para o modo avião</button><span class="xs muted" id="offInfoC"></span></div>
      <div class="cf-barra"><button class="primary" id="cfNovo">${ico('plus')} Nova conferência</button>
        <select id="cfFTipo" aria-label="Tipo"><option value="">Todos os tipos</option>${Object.keys(TIPOS).map(t => `<option value="${t}" ${f.tipo === t ? 'selected' : ''}>${TIPOS[t].nome}</option>`).join('')}</select>
        <input type="date" id="cfFData" aria-label="Dia"><select id="cfFOp" aria-label="Operador"><option value="">Todos os operadores</option></select></div>
      <div class="card" id="cfLista2"><div class="skeleton" style="height:80px"></div></div></div>`;
    const offInfo = () => { const p = Offline.pronto(); $('#offInfoC').textContent = p ? `Pronto: ${int(p.catalogo)} produtos neste aparelho` : 'Baixa os produtos para bipar sem internet (nomes e catálogo)'; };
    $('#offPrepC').addEventListener('click', async () => { $('#offPrepC').disabled = true; await Offline.preparar(); $('#offPrepC').disabled = false; offInfo(); });
    offInfo();
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
      const client_id = uuid(), nota = $('#cfNota').value.trim(), ts = new Date().toISOString();
      try {
        const c = await api('/api/conferencias', { method: 'POST', body: { tipo: tipoNovo, nota, client_id, operador: op(), ts }, tentativas: 0 });
        location.hash = '#/conferencia/' + c.id;
      } catch (e) {
        if (!e.rede) { toast(e.message, 'bad', 5000); $('#cfComecar').disabled = false; return; }
        // sem internet: a conferência nasce no aparelho e é criada no servidor quando a rede voltar
        const lid = 'L' + client_id.replace(/-/g, '').slice(0, 10);
        const c = { id: lid, tipo: tipoNovo, operador: op(), nota: nota || null, endereco: null, aberta_em: ts, fechada_em: null, aberta: true, itens: 0, linhas: 0, eans: 0, minutos: 0, processada: false };
        empilha({ conf: lid, criar: true, metodo: 'POST', url: '/api/conferencias', body: { tipo: tipoNovo, nota, client_id, operador: op(), ts } });
        lsSet('confCache:' + lid, { c, rows: [], nomes: {} });
        const ix = lsGet('confIndex', []); ix.unshift({ id: lid, tipo: tipoNovo, operador: op(), nota: nota || null, aberta_em: ts, fechada_em: null, itens: 0, eans: 0, linhas: 0, minutos: 0, aberta: true, processada: false }); lsSet('confIndex', ix.slice(0, 40));
        location.hash = '#/conferencia/' + lid;
      }
    });
    const ops = new Set([...(S.ops || []), op()].filter(Boolean).map(x => String(x).toUpperCase()));
    const linhaConf = c => `<a class="row click cf-row" href="#/conferencia/${c.id}" style="color:inherit">
          <span class="pill" style="--c:${estadoCor(c)}">${estadoTxt(c)}${ehLocal(c.id) && !idServidor(c.id) ? ' · só neste aparelho' : temPend(c.id) ? ' · a enviar' : ''}</span>
          <div><div class="pname"><b>${esc(nomeTipo(c.tipo))}</b> <span class="muted">· ${esc(c.operador)}${c.nota ? ' · NF ' + esc(c.nota) : ''}</span></div>
            <div class="xs muted">${dataBr(c.aberta_em)} · ${hora(c.aberta_em)}${c.fechada_em ? ' às ' + hora(c.fechada_em) : ''} · ${durTxt(c.minutos)}</div></div>
          <div style="text-align:right"><b class="num">${int(c.itens)}</b> <span class="xs muted">itens</span><div class="xs muted">${pl(c.eans, 'EAN', 'EANs')}</div></div></a>`;
    const carrega = async () => {
      let rows, offline = false;
      try { rows = await api('/api/conferencias?' + filtros(), { tentativas: 0 }); }
      catch (e) {
        if (!e.rede) throw e;
        offline = true;                                                    // sem internet: mostra o que está neste aparelho
        rows = lsGet('confIndex', []).filter(x => (!f.tipo || x.tipo === f.tipo) && (!f.operador || String(x.operador).toUpperCase() === f.operador));
      }
      // conferências criadas offline que ainda não subiram aparecem no topo
      if (!offline) { const locais = lsGet('confIndex', []).filter(x => ehLocal(x.id) && !idServidor(x.id) && (!f.tipo || x.tipo === f.tipo)); rows = [...locais, ...rows]; }
      rows.forEach(r => ops.add(String(r.operador).toUpperCase()));
      const sel = $('#cfFOp'); sel.innerHTML = '<option value="">Todos os operadores</option>' + [...ops].sort().map(o => `<option ${f.operador === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
      $('#cfLista2').innerHTML = (offline ? `<div class="callout warn" style="margin-bottom:10px">${ico('alert')}<div><b>Sem conexão.</b> Aparecem só as conferências deste aparelho; as demais voltam quando a internet voltar.</div></div>` : '') + (rows.length ? rows.map(linhaConf).join('') : '<p class="muted">Nenhuma conferência encontrada.</p>');
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
        ${h.abertas ? `<div class="xs muted" style="margin-top:8px">${pl(h.abertas, 'conferência aberta', 'conferências abertas')} · <a href="#/conferencias">ver</a></div>` : ''}${h.a_processar ? `<div class="xs muted" style="margin-top:6px"><b style="color:var(--warn)">${pl(h.a_processar, 'conferência finalizada', 'conferências finalizadas')}</b> esperando processar no sistema da loja · <a href="#/conferencias">ver</a></div>` : ''}</div>`;
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
