'use strict';
// Auditoria cega semanal: tela do coletor (contagem sem ver o saldo do sistema) e cartão "Confiança dos dados" da Visão geral.
const Auditoria = (() => {
  let raiz = null, dados = null, cont = null;     // cont = contagem em andamento { endereco, lotes, extras }
  const nome = () => (typeof S !== 'undefined' && S.op) || 'COLETOR';
  const fmtPct = v => (v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');
  const semCurta = s => 'S' + String(s).split('-W')[1];

  // ---------- lista da semana ----------
  async function abre(el) {
    if (el) raiz = el;
    if (!raiz) return;
    cont = null;
    raiz.innerHTML = '<p class="muted">Carregando a auditoria da semana…</p>';
    try { dados = await api('/api/auditoria?operador=' + encodeURIComponent(nome())); }
    catch (e) { raiz.innerHTML = `<p class="muted">${esc(e.status ? e.message : 'Sem conexão para carregar a auditoria.')}</p>`; return; }
    lista();
  }

  function cartaoEnd(i) {
    const r = i.resultado;
    const chips = i.status === 'feito'
      ? `<span class="rc ok">auditado</span><span class="rc">${r.confere} de ${r.lotes} bateram</span>${r.diferencas ? `<span class="rc warn">${r.diferencas} diferença${r.diferencas > 1 ? 's' : ''}</span>` : ''}`
      : `<span class="rc">${i.meu ? 'sua vez' : 'com ' + esc(i.auditor ? i.auditor.charAt(0) + i.auditor.slice(1).toLowerCase() : 'a equipe')}</span>${i.mesmo_operador ? '<span class="rc warn">mesmo operador da última contagem</span>' : ''}`;
    return `<div class="citem"><div><div style="font:700 26px var(--font-display);letter-spacing:-.02em">${esc(i.endereco)}</div>
      <div class="small muted">${esc(descEndereco(i.endereco))}</div><div class="chips" style="margin-top:8px">${chips}</div></div>
      <div>${i.status === 'pendente' && i.meu ? `<button class="primary" data-aud-abrir="${esc(i.endereco)}" style="min-height:44px">Auditar</button>`
        : i.status === 'feito' ? `<button class="sm" data-aud-ver="${esc(i.endereco)}" style="min-height:44px">Ver</button>` : ''}</div></div>`;
  }

  function lista() {
    const d = dados, p = d.progresso;
    const minhas = d.itens.filter(i => i.meu), outras = d.itens.filter(i => !i.meu);
    raiz.innerHTML = `<div class="rd-start">
      <h2>Auditoria da semana</h2>
      <p class="muted">Contagem às cegas: você digita o que encontra no local, sem ver o saldo do sistema. Serve para medir se as contagens são confiáveis.</p>
      <div class="rd-head" style="margin-top:12px"><span class="small muted">Semana ${esc(d.semana.replace('-W', ' · '))}</span><b>${p.feitos} de ${p.total} endereços auditados</b></div>
      <div class="prog" id="audProg"><i style="width:${p.total ? p.feitos / p.total * 100 : 0}%"></i></div></div>
      <div class="rd-g">Os seus endereços</div>
      ${minhas.length ? minhas.map(cartaoEnd).join('') : '<p class="muted small">Nenhum endereço atribuído a você nesta semana.</p>'}
      ${outras.length ? `<div class="rd-g">Com a equipe</div>${outras.map(cartaoEnd).join('')}` : ''}
      ${p.total ? '' : '<p class="muted">Ainda não há endereços com estoque para sortear.</p>'}`;
  }

  // ---------- contagem cega ----------
  async function inicia(endereco) {
    try {
      const r = await api('/api/auditoria/endereco/' + encodeURIComponent(endereco) + '?operador=' + encodeURIComponent(nome()));
      if (r.ja_feito) return resultado(r.resultado, r.endereco);
      cont = { endereco: r.endereco, lotes: r.lotes, extras: [] }; digitado = {};
      conta();
    } catch (e) { toast(e.status ? e.message : 'Sem conexão para abrir a auditoria', 'bad', 4000); }
  }

  function conta() {
    const c = cont;
    raiz.innerHTML = `<button class="sm" id="audVolta" style="margin-bottom:12px">${ico('chevron')} Voltar à lista</button>
      <div class="rd-start"><h2>${esc(c.endereco)}</h2><div class="small muted">${esc(descEndereco(c.endereco))}</div>
      <p class="muted" style="margin-top:8px">Conte o que está na prateleira e digite. Se não achar o lote, digite 0. O saldo do sistema fica escondido de propósito.</p></div>
      <div style="margin-top:14px">${c.lotes.map(l => `<div class="citem"><div><div class="pname">${esc(l.nome)}</div>
        <div class="muted small">lote ${esc(l.lote)} · vence ${esc(brData(l.validade))}</div></div>
        <div style="min-width:104px"><label class="xs muted" for="aq${l.id}">Encontrei</label><input id="aq${l.id}" data-aud-q="${l.id}" inputmode="numeric" autocomplete="off" style="width:100%;min-height:48px;text-align:center;font-size:20px" placeholder="qtd"></div></div>`).join('')
        || '<p class="muted">O sistema não tem lotes neste endereço. Se encontrar algo, inclua abaixo.</p>'}</div>
      <div id="audExtras">${c.extras.map((x, k) => `<div class="citem"><div><div class="pname">${esc(x.nome || 'EAN ' + x.ean)}</div><div class="muted small">fora da lista · lote ${esc(x.lote)} · vence ${esc(brData(x.validade))} · ${x.qtd} un.</div></div>
        <div><button class="sm" data-aud-rm="${k}" style="min-height:44px">Remover</button></div></div>`).join('')}</div>
      <div id="audNovo" hidden class="rd-start" style="margin:10px 0">
        <div class="f-wrap"><label class="f" for="axEan">Código de barras (EAN)</label>
          <div class="in"><input id="axEan" inputmode="numeric" autocomplete="off" placeholder="bipe ou digite"><button class="cam" id="axCam" aria-label="Ler código pela câmera">${ico('camera', 24)}</button></div></div>
        <div class="f-wrap" id="axNomeW"><label class="f" for="axNome">Nome do produto (só se o EAN for novo)</label><input id="axNome" autocomplete="off"></div>
        <div class="f-wrap"><label class="f" for="axLote">Lote</label><input id="axLote" autocomplete="off" autocapitalize="characters"></div>
        <div class="f-wrap"><label class="f" for="axVal">Validade (DDMMAA ou MM/AA)</label><input id="axVal" inputmode="numeric" autocomplete="off"></div>
        <div class="f-wrap"><label class="f" for="axQtd">Quantidade encontrada</label><input id="axQtd" inputmode="numeric" autocomplete="off"></div>
        <div class="rfim"><button class="big" id="axCancela">Cancelar</button><button class="big primary" id="axOk">Incluir</button></div></div>
      <button id="audMais" class="big">＋ Não estava na lista</button>
      <button id="audFim" class="big primary" style="margin-top:10px">Concluir auditoria</button>`;
  }

  async function incluiExtra() {
    const ean = $('#axEan').value.trim(), lote = $('#axLote').value.trim(), val = parseData($('#axVal').value), qtd = $('#axQtd').value.trim();
    if (!/^\d{8,14}$/.test(ean.replace(/\D/g, ''))) return toast('Informe o EAN do produto', 'bad');
    if (!lote) return toast('Informe o lote', 'bad');
    if (!val) return toast('Validade inválida', 'bad');
    if (!/^\d+$/.test(qtd) || +qtd < 1) return toast('Informe a quantidade encontrada', 'bad');
    // sem consultar o produto: essa consulta mostraria saldos do sistema e quebraria a contagem cega
    cont.extras.push({ ean: ean.replace(/\D/g, ''), nome: $('#axNome').value.trim(), lote, validade: val, qtd: +qtd });
    guardaDigitado(); conta(); restauraDigitado();
  }

  // conta() redesenha tudo: guarda e devolve o que já foi digitado nos campos de quantidade
  let digitado = {};
  const guardaDigitado = () => { digitado = {}; $$('[data-aud-q]').forEach(i => { digitado[i.dataset.audQ] = i.value; }); };
  const restauraDigitado = () => { $$('[data-aud-q]').forEach(i => { if (digitado[i.dataset.audQ] !== undefined) i.value = digitado[i.dataset.audQ]; }); };

  async function conclui() {
    guardaDigitado();
    const itens = [];
    for (const l of cont.lotes) {
      const v = String(digitado[l.id] ?? '').trim();
      if (!/^\d+$/.test(v)) return toast(`Falta digitar a quantidade de ${l.nome} (lote ${l.lote}). Se não achou, digite 0.`, 'bad', 5000), $(`#aq${l.id}`).focus();
      itens.push({ lote_id: l.id, qtd: +v });
    }
    if (!confirm('Concluir a auditoria? As quantidades contadas passam a ser o estoque deste endereço.')) return;
    const b = $('#audFim'); b.disabled = true;
    try {
      const r = await api('/api/auditoria/concluir', { method: 'POST', body: {
        endereco: cont.endereco, operador: nome(), itens,
        extras: cont.extras.map(x => ({ ean: x.ean, nome: x.nome || undefined, lote: x.lote, validade: x.validade, qtd: x.qtd })),
      } });
      cont = null;
      resultado(r.resultado, r.endereco);
    } catch (e) { toast(e.status ? e.message : 'Sem conexão. Nada foi gravado; tente de novo.', 'bad', 5000); b.disabled = false; }
  }

  // ---------- resultado ----------
  function resultado(r, endereco) {
    const dif = r.itens.filter(i => !i.confere);
    raiz.innerHTML = `<div class="rd-start"><h2>${r.diferencas ? 'Auditoria concluída' : 'Tudo bateu'}</h2>
      <div class="small muted">${esc(endereco)} · ${esc(descEndereco(endereco))}</div>
      <div class="chips" style="margin-top:12px"><span class="rc ok">${r.confere} bateram</span><span class="rc ${r.diferencas ? 'warn' : ''}">${r.diferencas} com diferença</span><span class="rc">${fmtPct(r.acuracia)} de acerto</span></div>
      <p class="muted" style="margin-top:10px">${r.diferencas ? 'O estoque deste endereço já foi corrigido para o que você contou.' : 'O saldo do sistema estava certo neste endereço.'}</p></div>
      ${dif.length ? `<div class="rd-g">Diferenças</div>${dif.map(i => `<div class="citem"><div><div class="pname">${esc(i.nome)}</div>
        <div class="muted small">lote ${esc(i.lote)} · vence ${esc(brData(i.validade))}${i.extra ? ' · não estava na lista' : ''}</div></div>
        <div style="text-align:right"><div class="small muted">sistema ${i.sistema}</div><b class="num" style="font-size:18px">contado ${i.contado}</b></div></div>`).join('')}` : ''}
      <button class="big primary" id="audVolta" style="margin-top:14px">Voltar à lista</button>`;
  }

  // ---------- eventos ----------
  function liga(el) {
    raiz = el;
    el.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'audVolta') return abre();
      if (b.dataset.audAbrir) return inicia(b.dataset.audAbrir);
      if (b.dataset.audVer) return inicia(b.dataset.audVer);
      if (!cont) return;
      if (b.id === 'audMais') { $('#audNovo').hidden = false; b.hidden = true; return $('#axEan').focus(); }
      if (b.id === 'axCancela') { $('#audNovo').hidden = true; $('#audMais').hidden = false; return; }
      if (b.id === 'axOk') return incluiExtra();
      if (b.id === 'axCam') {
        try { const v = await Scanner.abrir({ titulo: 'Aponte para o código de barras do produto', aceitar: 'ean' }); if (v) $('#axEan').value = v; } catch (er) { toast(er.message || 'Não consegui abrir a câmera', 'bad'); }
        return;
      }
      if (b.dataset.audRm !== undefined) { guardaDigitado(); cont.extras.splice(+b.dataset.audRm, 1); conta(); restauraDigitado(); return; }
      if (b.id === 'audFim') return conclui();
    });
  }

  // ---------- cartão da Visão geral ----------
  async function cartao(el) {
    if (!el) return;
    let p;
    try { p = await api('/api/auditoria/painel?semanas=8'); } catch { el.innerHTML = ''; return; }
    if (!el.isConnected) return;
    const max = 100, u = p.ultima;
    const barras = p.semanas.map(s => `<div title="${esc(s.semana)}: ${s.acuracia === null ? 'sem auditoria' : fmtPct(s.acuracia) + ' de ' + s.lotes + ' lotes'}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">
      <div style="height:44px;width:100%;display:flex;align-items:flex-end"><div style="width:100%;height:${s.acuracia === null ? 4 : Math.max(6, s.acuracia / max * 100)}%;border-radius:4px 4px 2px 2px;background:${s.acuracia === null ? 'var(--surface-2)' : s.acuracia >= 95 ? 'var(--good)' : s.acuracia >= 85 ? 'var(--warn)' : 'var(--bad)'}"></div></div>
      <span class="xs muted">${esc(semCurta(s.semana))}</span></div>`).join('');
    el.innerHTML = `<div class="card reveal" style="--i:11"><div class="head"><div><h2>Confiança dos dados</h2><div class="sub">Auditoria cega semanal por amostragem</div></div></div>
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><b class="num" style="font-size:34px">${u ? fmtPct(u.acuracia) : '—'}</b>
        <span class="small muted">${u ? `dos lotes batiam com o sistema (${esc(semCurta(u.semana))}, ${u.lotes} lotes)` : 'ainda sem auditoria concluída'}</span></div>
      <div style="display:flex;gap:6px;margin:14px 0 10px" aria-label="Acerto nas últimas 8 semanas">${barras}</div>
      <div class="small muted">${p.atual.auditados} de ${p.atual.planejados} endereços auditados esta semana</div>
      ${p.por_operador && p.por_operador.length ? `<div class="rd-g" style="margin-top:14px">Por contagem anterior</div><div class="xs muted" style="margin:-4px 0 6px">${esc(p.nota)}</div>
        ${p.por_operador.map(o => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span>${esc(o.operador.charAt(0) + o.operador.slice(1).toLowerCase())} <span class="xs muted">${o.lotes} lotes</span></span><b class="num">${fmtPct(o.acuracia)}</b></div>`).join('')}` : ''}</div>`;
  }

  return { abre, liga, cartao };
})();
