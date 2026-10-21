(async () => {
  const dt = iso => iso ? iso.split('-').reverse().join('/') : '';
  const dm = iso => iso ? iso.split('-').reverse().slice(0, 2).join('/') : '';
  const num = n => n.toLocaleString('pt-BR');
  $('#imprime').addEventListener('click', () => window.print());
  let b;
  try { b = await api('/api/briefing-semanal'); } catch (e) { $('#folha').innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }

  // Delta com seta. `fmt` formata o valor absoluto; sem base de comparação, diz isso em vez de inventar.
  const delta = (v, fmt, base) => {
    if (v.delta === null) return `<span class="dl">sem base de comparação</span>`;
    const seta = v.delta === 0 ? '→' : v.delta > 0 ? '▲' : '▼';
    const pct = v.delta_pct === null ? '' : ` (${v.delta_pct > 0 ? '+' : ''}${num(v.delta_pct)}%)`;
    return `<span class="dl ${v.sentido === 'igual' ? '' : v.sentido}">${seta} ${v.delta > 0 ? '+' : v.delta < 0 ? '−' : ''}${fmt(Math.abs(v.delta))}${pct} vs ${base}</span>`;
  };
  const kpi = (rot, v, fmt, fmtSub, base, cls = '') =>
    `<div class="kpi ${cls}"><small>${rot}</small><b>${v.atual === null ? '—' : fmt(v.atual)}</b>${fmtSub || ''}${delta(v, fmt, base)}</div>`;

  const k = b.kpis, baseSnap = b.comparacao.snapshot_anterior ? dm(b.comparacao.snapshot_anterior) : 'semana anterior';
  const lotesTxt = v => v.atual === null ? '' : ` <small>${v.atual} lotes${v.delta !== null ? ` (${v.delta > 0 ? '+' : v.delta < 0 ? '−' : ''}${Math.abs(v.delta)})` : ''}</small>`;
  const pctF = n => num(n) + '%';

  const tabPareto = (p, vazio) => p.itens.length ? `<table><thead><tr><th>#</th><th>Nome</th><th class="n">Perda</th><th class="n">%</th><th class="n">Acum.</th><th></th></tr></thead><tbody>${p.itens.map((i, n) =>
    `<tr><td>${n + 1}</td><td>${esc(i.nome)}</td><td class="n">${brl(i.perda)}</td><td class="n">${pctF(i.pct)}</td><td class="n"><b>${pctF(i.acum)}</b></td><td class="b"><div class="barra-p" style="width:${Math.max(2, Math.min(100, i.acum))}%"></div></td></tr>`).join('')}</tbody></table>
    <p class="nota">Perda total estimada: ${brl(p.total)}${p.outros ? `. Mais ${p.outros} fora do top 5.` : '.'}</p>` : `<p class="vazio">${vazio}</p>`;

  // Sparkline: só pontos com dado real; semanas sem registro ficam sem marcador.
  const W = 230, H = 50, pad = 6;
  const vals = b.tendencia.map(t => t.valor);
  const reais = vals.filter(v => v !== null);
  const max = Math.max(...reais, 1), min = Math.min(...reais, 0);
  const px = i => pad + i * (W - 2 * pad) / 3;
  const py = v => H - pad - (v - min) / ((max - min) || 1) * (H - 2 * pad);
  let seg = '', path = '';
  b.tendencia.forEach((t, i) => { if (t.valor === null) { seg = ''; return; } path += `${seg ? 'L' : 'M'}${px(i).toFixed(1)},${py(t.valor).toFixed(1)} `; seg = 'x'; });
  const pontos = b.tendencia.map((t, i) => t.valor === null ? '' : `<circle cx="${px(i).toFixed(1)}" cy="${py(t.valor).toFixed(1)}" r="2.6" fill="#013a7b"/>`).join('');
  const spark = reais.length ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vencido em estoque nas últimas 4 semanas"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#c9d3e0"/><path d="${path}" fill="none" stroke="#013a7b" stroke-width="1.6"/>${pontos}</svg>` : '';
  const legenda = b.tendencia.map(t => `<li>${t.semana === 'hoje' ? 'hoje' : t.semana}: <b>${t.valor === null ? 'sem registro' : brl(t.valor)}</b></li>`).join('');
  const aviso = !b.historico.inicio ? 'Sem histórico ainda.' : !b.historico.completo ? `Histórico começou em ${dt(b.historico.inicio)}: ainda não há 4 semanas completas.` : '';

  const pend = b.pendentes;
  $('#folha').innerHTML = `
    <header><div><h1>Briefing semanal · AP52 São Pedro</h1><div style="color:#364a68">Controle de validade, para o gerente e a rede</div></div><div class="d"><b>Semana de ${dt(b.periodo.de)} a ${dt(b.periodo.ate)}</b></div></header>
    <h2>1. Indicadores <span>esta semana contra a anterior</span></h2>
    <div class="kpis kpis4">
      ${kpi('Vencido em estoque', k.vencido_valor, brl, lotesTxt(k.vencido_lotes), baseSnap, 'r')}
      ${kpi('Valor em risco (até 90 dias)', k.valor_risco, brl, '', baseSnap)}
      ${kpi('Rondas feitas (dias)', k.rondas, n => `${n} de ${b.rondas.meta}`, '', 'sem. anterior')}
      ${kpi('Divergência da ronda', k.divergencia, n => num(n) + '%', k.divergencia.atual === null ? ' <small>sem rondas</small>' : ' <small>corrigidos ou não achei</small>', 'sem. anterior')}
    </div>
    <h2>2. Onde está a perda <span>Pareto da perda estimada, top 5</span></h2>
    <div class="duas"><div><b>Marcas</b>${tabPareto(b.marcas, 'Sem perda estimada.')}</div><div><b>Gôndolas</b>${tabPareto(b.gondolas, 'Sem perda estimada.')}</div></div>
    <h2>3. Tendência <span>vencido em estoque, últimas 4 semanas</span></h2>
    <div class="tend">${spark}<ul>${legenda}</ul></div>
    ${aviso ? `<p class="aviso">${esc(aviso)}</p>` : ''}
    <h2>4. Decisão pedida <span>escrita a partir dos números acima</span></h2>
    ${b.decisoes.length ? `<ol class="dec">${b.decisoes.map(d => `<li>${esc(d)}</li>`).join('')}</ol>` : '<p class="vazio">Nenhuma decisão pendente esta semana.</p>'}
    <h2>5. Pendências <span>gôndolas sem ronda há mais de ${pend.limite_dias} dias</span></h2>
    ${pend.total ? `<div class="pend">${pend.itens.map(g => `<span><span class="cx"></span> <b>${esc(g.nome)}</b> <span class="venc">${g.nunca ? 'nunca contada' : g.dias_sem_ronda + ' d'}</span></span>`).join('')}</div>${pend.total > pend.itens.length ? `<p class="nota">+ ${pend.total - pend.itens.length} gôndolas além destas.</p>` : ''}` : '<p class="vazio">Todas as gôndolas com estoque tiveram ronda recente.</p>'}
    <footer><span>Visto do gerente: ______________________ &nbsp; Data: ____/____/______</span><span>Gerado em ${new Date().toLocaleString('pt-BR')}</span></footer>`;
  document.title = 'Briefing semanal ' + dt(b.hoje).replace(/\//g, '-') + ' · AP52';
})();
