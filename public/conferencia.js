(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const nomeTipo = { RECEBIMENTO: 'Recebimento', VALIDADE: 'Validade', CONTAGEM: 'Contagem', RONDA: 'Ronda do dia' };
  const dt = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hr = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dur = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`);
  $('#imprime').addEventListener('click', () => window.print());
  $('#csv').href = '/api/conferencias/' + encodeURIComponent(id || '') + '.csv';
  $('#csv').setAttribute('download', '');
  if (!id) { $('#folha').innerHTML = '<p class="erro">Conferência não informada.</p>'; return; }
  let d;
  try { d = await api('/api/conferencias/' + encodeURIComponent(id)); } catch (e) { $('#folha').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  const c = d.conferencia, itens = d.itens;
  const comEsp = itens.some(i => i.esperado !== null && i.esperado !== undefined);
  const rotEsp = c.tipo === 'RONDA' ? 'Sistema' : 'Esperado';
  const linha = i => {
    let cls = '';
    if (comEsp && i.esperado !== null && i.esperado !== undefined) {
      cls = i.qtd === i.esperado ? 'ok' : i.qtd > i.esperado ? 'mais' : 'menos';
    }
    return `<tr><td class="e">${esc(i.ean)}</td><td class="p">${esc(i.nome || 'Produto sem cadastro')}</td><td class="q ${cls}">${int(i.qtd)}</td>
      <td class="l">${esc(i.lote || '')}</td><td class="v">${esc(brData(i.validade))}</td><td class="n">${esc(i.endereco || '')}</td>${comEsp ? `<td class="q ${cls}">${i.esperado ?? ''}</td>` : ''}</tr>`;
  };
  const total = itens.reduce((s, i) => s + i.qtd, 0), eans = new Set(itens.map(i => i.ean)).size;
  const fim = c.fechada_em ? hr(c.fechada_em) : 'em andamento';
  $('#folha').innerHTML = `
    <header><div><h1>Conferência de ${esc((nomeTipo[c.tipo] || c.tipo).toLowerCase())} · AP52 São Pedro</h1><div style="color:#364a68">Lista em ordem alfabética do produto${c.aberta ? ' · conferência ainda aberta' : ''}</div></div>
      <div class="d"><b>${dt(c.aberta_em)}</b><br>Conferência nº ${c.id}</div></header>
    <div class="info">
      <div><small>Tipo</small><b>${esc(nomeTipo[c.tipo] || c.tipo)}</b></div>
      <div><small>Operador</small><b>${esc(c.operador)}</b></div>
      <div><small>Início · fim</small><b>${hr(c.aberta_em)} · ${fim}</b></div>
      <div><small>Duração</small><b>${dur(c.minutos)}</b></div>
      ${c.nota ? `<div><small>Nota fiscal</small><b>${esc(c.nota)}</b></div>` : ''}
      <div><small>Itens</small><b>${int(total)}</b></div>
      <div><small>EANs</small><b>${int(eans)}</b></div>
      <div><small>Linhas</small><b>${int(itens.length)}</b></div>
    </div>
    ${itens.length ? `<div class="tab"><table><thead><tr><th>EAN</th><th>Produto</th><th class="q">Qtd</th><th>Lote</th><th>Validade</th><th>Endereço</th>${comEsp ? `<th class="q">${rotEsp}</th>` : ''}</tr></thead>
      <tbody>${itens.map(linha).join('')}</tbody></table></div>` : '<p class="vazio">Nenhum item lido.</p>'}
    <div class="total"><span>Total: ${int(total)} ${total === 1 ? 'item' : 'itens'} · ${int(eans)} ${eans === 1 ? 'EAN' : 'EANs'} · ${int(itens.length)} ${itens.length === 1 ? 'linha' : 'linhas'}</span><span>Gerado em ${new Date().toLocaleString('pt-BR')}</span></div>`;
  document.title = `Conferência ${c.id} ${nomeTipo[c.tipo] || ''} ${dt(c.aberta_em).replace(/\//g, '-')} · AP52`;
})();
