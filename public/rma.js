(async () => {
  const dt = iso => (iso ? iso.split('-').reverse().join('/') : '');
  const q = new URLSearchParams(location.search);
  const de = $('#de'), ate = $('#ate');
  async function carrega() {
    const p = new URLSearchParams();
    if (de.value) p.set('de', de.value);
    if (ate.value) p.set('ate', ate.value);
    let r;
    try { r = await api('/api/rma?' + p); } catch (e) { $('#folha').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
    de.value = r.de; ate.value = r.ate;
    $('#csv').href = '/api/rma.csv?de=' + r.de + '&ate=' + r.ate;
    history.replaceState(null, '', '?de=' + r.de + '&ate=' + r.ate);
    document.title = 'Avaria e RMA ' + dt(r.de) + ' a ' + dt(r.ate) + ' · AP52';
    const t = r.totais;
    $('#folha').innerHTML = `<header><div><h1>Avaria e RMA · AP52 São Pedro</h1><div style="color:#364a68">Para lançar no Registro de avaria do sistema da loja</div></div><div class="d"><b>${dt(r.de)} a ${dt(r.ate)}</b></div></header>
      <div class="kpis"><span><b>${t.linhas}</b> linhas</span><span><b>${t.qtd}</b> unidades</span><span><b>${t.vencidos}</b> vencidos</span><span><b>${t.avariados}</b> avariados</span></div>
      ${r.itens.length ? `<table><thead><tr><th class="c"></th><th>Produto</th><th>Lote</th><th>Situação</th><th>Validade</th><th>Causa</th><th class="q">Qtd</th></tr></thead><tbody>${r.itens.map(i =>
        `<tr><td class="c"><span class="cx"></span></td><td>${esc(i.nome)}<div style="color:#627590;font-size:9.5px">${esc(i.ean)}</div></td><td>${esc(i.lote)}</td><td>${i.situacao === 'Vencido' ? '<span class="venc">Vencido</span>' : 'Avariado'}</td><td>${i.validade ? dt(i.validade) : ''}</td><td>${esc(i.causa)}</td><td class="q">${i.qtd}</td></tr>`).join('')}</tbody></table>`
        : '<p class="vazio">Nenhuma baixa por RMA, avaria ou retirada preventiva neste período.</p>'}
      <p class="nota">Em ordem alfabética. A validade só aparece nos vencidos, como no registro do sistema da loja. A mesma lista sai em CSV (botão acima).</p>`;
  }
  de.value = q.get('de') || ''; ate.value = q.get('ate') || '';
  $('#aplica').addEventListener('click', carrega);
  $('#imprime').addEventListener('click', () => window.print());
  carrega();
})();
