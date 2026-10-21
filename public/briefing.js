(async () => {
  const dt = iso => iso ? iso.split('-').reverse().join('/') : '';
  const nomeBonito = n => n.charAt(0) + n.slice(1).toLowerCase();
  const resp = r => r && r.length ? esc(r.map(nomeBonito).join(', ')) : '';
  const venceu = d => d === 0 ? '<span class="venc">vence hoje</span>' : d < 0 ? `<span class="venc">venceu há ${-d} d</span>` : d <= 30 ? `<span class="urg">${d} dias</span>` : `${d} dias`;
  $('#imprime').addEventListener('click', () => window.print());
  let b;
  try { b = await api('/api/briefing'); } catch (e) { $('#folha').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  const semana = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][new Date(b.hoje + 'T12:00:00').getDay()];
  const tabela = (itens, extra) => itens.length ? `<table><thead><tr><th class="c"></th><th>Local</th><th>Produto</th><th>Lote</th><th class="q">Qtd</th><th class="v">${extra}</th><th>Quem</th></tr></thead><tbody>${itens.map(i =>
    `<tr><td class="c"><span class="cx"></span></td><td class="l">${esc(i.endereco || '—')}</td><td>${esc(i.nome)}</td><td>${esc(i.lote || '')}</td><td class="q">${i.qtd}</td><td class="v">${extra === 'Validade' ? venceu(i.dias) : venceu(i.dias)}</td><td class="r">${resp(i.resp)}</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Nada por aqui hoje.</p>';
  const mais = (s, onde) => s.total > s.mostrados ? `<p class="mais">+ ${s.total - s.mostrados} lotes além destes. Lista completa no app (${onde}).</p>` : '';
  $('#folha').innerHTML = `
    <header><div><h1>Plano do dia · AP52 São Pedro</h1><div style="color:#364a68">Controle de validade</div></div><div class="d"><b>${semana}, ${dt(b.hoje)}</b></div></header>
    <div class="kpis">
      <div class="kpi r"><small>Vencido em estoque</small><b>${brl(b.totais.vencido_valor)}</b> <small>${b.totais.vencido_lotes} lotes</small></div>
      <div class="kpi"><small>Valor em risco (até 90 dias)</small><b>${brl(b.totais.valor_em_risco)}</b></div>
      <div class="kpi"><small>Etiquetas a trocar</small><b>${b.totais.etiquetar_lotes}</b> <small>lotes</small></div>
    </div>
    <h2>1. Retirar para RMA (CD) <span>maiores valores primeiro, na ordem de caminhada</span></h2>
    ${tabela(b.retirar.itens, 'Venceu')}${mais(b.retirar, 'Estoque, filtro Vencido')}
    <h2>2. Etiquetar com desconto <span>mais próximos do vencimento primeiro</span></h2>
    ${tabela(b.etiquetar.itens, 'Validade')}${mais(b.etiquetar, 'Estoque, filtro Alerta')}
    <h2>3. Ronda de hoje <span>conferir e confirmar no coletor (${b.ronda.conferidos_hoje} já feitos hoje)</span></h2>
    ${b.ronda.enderecos.length ? `<div class="ronda">${b.ronda.enderecos.map(e => `<div><span class="cx"></span><span class="e">${esc(e.endereco)}</span><span>${e.vencidos ? `<span class="venc">${e.vencidos} vencido${e.vencidos > 1 ? 's' : ''}</span> ` : ''}${e.urgentes ? `<span class="urg">${e.urgentes} urgente${e.urgentes > 1 ? 's' : ''}</span>` : ''}</span><span class="n">${resp(e.resp)}${e.resp && e.resp.length ? ' · ' : ''}${e.nunca ? 'nunca contado' : e.dias_sem + ' d sem contar'}</span></div>`).join('')}</div>` : '<p class="vazio">Todos os endereços já foram conferidos hoje.</p>'}
    ${b.marcas.length ? `<h2>Marcas que mais pesam <span>perda estimada</span></h2><div>${b.marcas.map(m => `${esc(m.marca)}: <b>${brl(m.perda)}</b>`).join(' &nbsp;·&nbsp; ')}</div>` : ''}
    <footer><span>Feito por: ______________________ &nbsp; Visto do gerente: ______________________</span><span>Gerado em ${new Date().toLocaleString('pt-BR')}</span></footer>`;
  document.title = 'Briefing ' + dt(b.hoje).replace(/\//g, '-') + ' · AP52';
})();
