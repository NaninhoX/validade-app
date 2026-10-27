'use strict';
// Causa da perda: diálogo de baixa (Estoque e coletor) e card "Por que perdemos" (Visão geral).
// Depende de common.js (esc, brl, $, api, ico). Mantenha as listas iguais às de lib/causas.js (o servidor é quem valida).
const Causa = (() => {
  const CAUSAS = ['Comprei demais', 'Giro baixo', 'Entrou com pouco prazo', 'Ficou escondido ou mal exposto', 'Etiqueta/promoção não feita a tempo', 'Outro'];
  const MOTIVOS_COM_CAUSA = ['RMA', 'Avaria', 'Retirada Preventiva'];
  const MOTIVOS_PADRAO = ['Venda', 'RMA', 'Avaria', 'Furto', 'Retirada Preventiva', 'Doação', 'Outro'];
  const exige = motivo => MOTIVOS_COM_CAUSA.includes(motivo);

  function criaDialogo() {
    let dlg = document.getElementById('dlgBaixa');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'dlgBaixa';
    dlg.innerHTML = `<form method="dialog" id="dbForm" novalidate>
      <h2 id="dbTitulo" style="font-size:20px"></h2>
      <p class="muted small" id="dbSub" style="margin-top:4px;margin-bottom:16px"></p>
      <div id="dbQtdBox" class="field"><label class="f" for="dbQtd">Quantidade</label><input id="dbQtd" type="number" min="1" inputmode="numeric" autocomplete="off"></div>
      <div class="field"><label class="f" for="dbMotivo">Motivo</label><select id="dbMotivo"></select></div>
      <div class="field" id="dbCausaBox" hidden><label class="f" id="dbCausaLbl">Causa da perda (obrigatória)</label>
        <div class="causa-grid" id="dbCausas" role="group" aria-labelledby="dbCausaLbl"></div></div>
      <div class="causa-erro" id="dbErro" role="alert" hidden></div>
      <menu><button type="button" id="dbCancel">Cancelar</button><button type="submit" id="dbOk" class="primary">Confirmar</button></menu>
    </form>`;
    document.body.appendChild(dlg);
    return dlg;
  }

  // Grade de botões grandes; devolve a função que lê a causa escolhida.
  function chips(el, aoMudar) {
    let sel = null;
    el.innerHTML = CAUSAS.map(c => `<button type="button" class="causa-chip" aria-pressed="false" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    el.onclick = e => {
      const b = e.target.closest('button[data-c]'); if (!b) return;
      sel = b.dataset.c;
      el.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      aoMudar();
    };
    return { get: () => sel };
  }

  // Baixa com causa. Devolve { qtd, motivo, causa } ou null se cancelou.
  // opcoes: { titulo, sub, saldo, motivos, vencido }
  function dialogoBaixa({ titulo = 'Dar baixa', sub = '', saldo = 1, motivos = MOTIVOS_PADRAO, vencido = false, semQtd = false } = {}) {
    return new Promise(resolve => {
      const dlg = criaDialogo();
      const lista = vencido ? ['RMA', ...motivos.filter(x => x !== 'RMA')] : motivos;
      $('#dbTitulo').textContent = titulo; $('#dbSub').textContent = sub;
      $('#dbQtd').value = saldo;
      $('#dbQtdBox').hidden = !!semQtd;                    // baixa em lote: sempre o saldo inteiro de cada lote
      $('#dbMotivo').innerHTML = lista.map(o => `<option>${esc(o)}</option>`).join('');
      const erro = $('#dbErro'), box = $('#dbCausaBox');
      const mostraErro = t => { erro.textContent = t || ''; erro.hidden = !t; box.classList.toggle('invalido', !!t && /causa/i.test(t)); };
      const ch = chips($('#dbCausas'), () => mostraErro(''));
      const atualiza = () => { box.hidden = !exige($('#dbMotivo').value); mostraErro(''); };
      $('#dbMotivo').onchange = atualiza; atualiza();
      const fim = v => { $('#dbQtdBox').hidden = false; dlg.close(); resolve(v); };
      $('#dbCancel').onclick = () => fim(null);
      dlg.oncancel = () => { $('#dbQtdBox').hidden = false; resolve(null); };
      $('#dbForm').onsubmit = e => {
        e.preventDefault();
        const q = semQtd ? '1' : $('#dbQtd').value.trim();
        if (!/^\d+$/.test(q) || +q < 1) { mostraErro('Informe a quantidade (1 ou mais).'); return; }
        const motivo = $('#dbMotivo').value;
        if (exige(motivo) && !ch.get()) { mostraErro('Escolha a causa da perda para registrar a baixa.'); box.scrollIntoView({ block: 'nearest' }); return; }
        fim({ qtd: +q, motivo, causa: exige(motivo) ? ch.get() : null });
      };
      dlg.showModal();
      if (semQtd) $('#dbMotivo').focus(); else { $('#dbQtd').focus(); $('#dbQtd').select(); }
    });
  }

  // Só a causa (retirada de vencido na ronda, que já é RMA). Devolve a causa ou null.
  function escolherCausa({ titulo = 'Por que perdemos este item?', sub = '' } = {}) {
    return new Promise(resolve => {
      const dlg = criaDialogo();
      $('#dbTitulo').textContent = titulo; $('#dbSub').textContent = sub;
      $('#dbQtdBox').hidden = true;
      $('#dbMotivo').closest('.field').hidden = true;
      const erro = $('#dbErro'), box = $('#dbCausaBox');
      box.hidden = false; erro.hidden = true;
      const ch = chips($('#dbCausas'), () => { erro.hidden = true; box.classList.remove('invalido'); });
      const restaura = () => { $('#dbQtdBox').hidden = false; $('#dbMotivo').closest('.field').hidden = false; };
      const fim = v => { restaura(); dlg.close(); resolve(v); };
      $('#dbCancel').onclick = () => fim(null);
      dlg.oncancel = () => { restaura(); resolve(null); };
      $('#dbForm').onsubmit = e => {
        e.preventDefault();
        if (!ch.get()) { erro.textContent = 'Escolha a causa da perda para continuar.'; erro.hidden = false; box.classList.add('invalido'); return; }
        fim(ch.get());
      };
      dlg.showModal();
    });
  }

  // ---------- card "Por que perdemos" ----------
  function barras(d) {
    if (!d.itens.length) return '<p class="muted small">Ainda sem dados. As causas aparecem aqui quando houver baixas por RMA, avaria ou retirada preventiva.</p>';
    const max = Math.max(1, ...d.itens.map(x => x.pct));
    return d.itens.map(x => `<div class="causa-linha${x.causa === 'Sem causa registrada' ? ' sem' : ''}">
      <div class="causa-topo"><span>${esc(x.causa)}</span><b class="num">${x.qtd} un · ${x.pct.toLocaleString('pt-BR')}%</b></div>
      <div class="meter"><i style="width:${x.pct / max * 100}%"></i></div>
      <div class="xs muted">${x.valor > 0 ? '~' + brl(x.valor) + ' · ' : ''}acumulado ${x.pct_acum.toLocaleString('pt-BR')}%</div></div>`).join('')
      + (d.qtd_sem_preco ? `<p class="xs muted" style="margin-top:6px">${d.qtd_sem_preco} un sem preço cadastrado ficaram fora do valor em R$.</p>` : '');
  }

  async function montaCard(el, dias = 30) {
    el.innerHTML = `<div class="head"><div><h2>Por que perdemos</h2><div class="sub">Causa das baixas por RMA, avaria e retirada preventiva</div></div>
      <div class="seg" id="causaDias" role="group" aria-label="Período"><button data-d="30" aria-pressed="${dias === 30}">30 dias</button><button data-d="90" aria-pressed="${dias === 90}">90 dias</button></div></div>
      <div id="causaCorpo"><p class="muted small">Carregando…</p></div>`;
    $('#causaDias').onclick = e => { const b = e.target.closest('button[data-d]'); if (b && +b.dataset.d !== dias) montaCard(el, +b.dataset.d); };
    try { $('#causaCorpo').innerHTML = barras(await api('/api/causas?dias=' + dias)); }
    catch (e) { $('#causaCorpo').innerHTML = `<p class="muted small">Não consegui carregar: ${esc(e.message)}</p>`; }
  }

  return { CAUSAS, MOTIVOS_COM_CAUSA, MOTIVOS_PADRAO, exige, dialogoBaixa, escolherCausa, montaCard };
})();
