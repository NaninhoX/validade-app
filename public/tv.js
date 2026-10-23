'use strict';
// Modo TV: painel de parede, sempre escuro, que se atualiza sozinho a cada minuto (#/tv).
// Dados: /api/resumo (KPIs, status, muro, marcas), /api/mapa (planta com calor), /api/fila (o que fazer),
// /api/conferencias/hoje e /api/auditoria/painel (rotina do dia). Tudo desenhado em SVG/HTML, sem biblioteca.
(() => {
  const SP = 'America/Sao_Paulo';
  const horaSP = d => d.toLocaleTimeString('pt-BR', { timeZone: SP, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  let timer = null, DADOS = null;

  const rotuloMes = k => (/^\d{4}-\d{2}$/.test(k) ? MESES[+k.slice(5) - 1] + (k.slice(2, 4) !== new Date().getFullYear().toString().slice(2) ? '/' + k.slice(2, 4) : '') : k === 'Vencidos' ? 'Venc.' : k);

  async function busca() {
    const opc = u => api(u).catch(() => null);
    const [resumo, mapa, fila, hoje, aud] = await Promise.all([api('/api/resumo'), opc('/api/mapa'), opc('/api/fila?limite=8'), opc('/api/conferencias/hoje'), opc('/api/auditoria/painel?semanas=4')]);
    return { resumo, mapa, fila: fila || [], hoje, aud };
  }

  const kpi = (rot, val, hint, cls = '') => `<div class="tv-kpi ${cls}"><span class="tv-kl">${rot}</span><b>${val}</b><small>${hint}</small></div>`;

  function kpis(d) {
    const t = d.resumo.totais, venc = d.resumo.por_status[0] || { valor: 0, lotes: 0 };
    const tt = (campo, o) => { const x = tendKpi(d.resumo, campo, o); return x ? ' · ' + x.txt : ''; };
    return `<div class="tv-kpis">
      ${kpi('Valor em estoque', brl(t.valor), `${int(t.itens)} itens · ${int(t.lotes)} lotes` + tt('valor_total', { descerEBom: null }))}
      ${kpi('Vencido na loja', brl(venc.valor), `${int(venc.lotes)} lotes para retirar` + tt('vencido_valor', { descerEBom: true }), venc.lotes ? 'bad' : 'ok')}
      ${kpi('Em risco (até 90 dias)', brl(t.valor_em_risco), 'valor que vence em breve' + tt('valor_risco', { descerEBom: true }), 'warn')}
      ${kpi('Perda potencial', brl(t.perda_potencial), 'se vender com o desconto da regra')}
      ${kpi('Perda potencial evitada', brl(d.resumo.evitada ? d.resumo.evitada.evitada : 0), d.resumo.evitada && d.resumo.evitada.evitada ? 'acumulado · ' + brl(d.resumo.evitada.ultimos.evitada) + ' em ' + d.resumo.evitada.ultimos.dias + ' dias' : 'sem vendas registradas', 'ok')}
    </div>`;
  }

  // rosca por status, com o total de lotes no centro
  function rosca(d) {
    const ps = d.resumo.por_status.filter(s => s.lotes > 0), tot = ps.reduce((s, x) => s + x.lotes, 0) || 1;
    const R = 70, C = 2 * Math.PI * R; let off = 0;
    const arcos = ps.map(s => { const len = s.lotes / tot * C, a = `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${s.cor}" stroke-width="26" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 90 90)"/>`; off += len; return a; }).join('');
    return `<div class="tv-rosca"><svg viewBox="0 0 180 180" role="img" aria-label="Lotes por status">${arcos}<text x="90" y="88" text-anchor="middle" class="tv-rn">${int(tot)}</text><text x="90" y="110" text-anchor="middle" class="tv-rs">lotes</text></svg>
      <ul>${d.resumo.por_status.map(s => `<li><i style="background:${s.cor}"></i><span>${esc(s.status)}</span><b>${int(s.lotes)}</b></li>`).join('')}</ul></div>`;
  }

  // muro de validade: barras por mês
  function muro(d) {
    const m = d.resumo.muro.filter(x => x.chave !== 'Depois' || x.qtd > 0), max = Math.max(1, ...m.map(x => x.qtd));
    const W = 560, H = 190, bw = W / m.length;
    const barras = m.map((x, i) => {
      const h = Math.round(x.qtd / max * (H - 44)), v = x.chave === 'Vencidos', cor = v ? 'var(--bad)' : i <= 2 ? 'var(--warn)' : 'var(--accent)';
      return `<g><rect x="${i * bw + bw * .18}" y="${H - 22 - h}" width="${bw * .64}" height="${Math.max(h, x.qtd ? 2 : 0)}" rx="3" fill="${cor}"/>
        <text x="${i * bw + bw / 2}" y="${H - 26 - h}" text-anchor="middle" class="tv-bv">${x.qtd ? int(x.qtd) : ''}</text>
        <text x="${i * bw + bw / 2}" y="${H - 6}" text-anchor="middle" class="tv-bl">${esc(rotuloMes(x.chave))}</text></g>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="tv-muro" role="img" aria-label="Itens que vencem por mês">${barras}</svg>`;
  }

  // planta da loja com calor por gôndola (cor do pior status), proporcional ao layout salvo
  function planta(d) {
    const L = d.mapa && d.mapa.layout; if (!L || !L.gondolas.length) return '<div class="tv-vazio">Planta ainda não desenhada.</div>';
    const por = new Map(d.mapa.gondolas.map(g => [g.id, g]));
    const f = 1 / 1;
    const caixas = L.gondolas.map(g => {
      const x = por.get(g.id), cor = x && x.lotes ? x.cor : 'var(--tv-vazio)', w = g.w * f, h = g.h * f;
      const rot = Math.max(w, h) > 40;
      return `<g><rect x="${g.x}" y="${g.y}" width="${w}" height="${h}" rx="4" fill="${cor}" opacity="${x && x.lotes ? .92 : .55}"/>
        ${rot ? `<text x="${g.x + w / 2}" y="${g.y + h / 2 + 5}" text-anchor="middle" class="tv-pn">${g.id}</text>` : ''}
        ${x && x.vencidos ? `<circle cx="${g.x + w}" cy="${g.y}" r="11" fill="var(--bad)"/><text x="${g.x + w}" y="${g.y + 4}" text-anchor="middle" class="tv-pb">${x.vencidos}</text>` : ''}</g>`;
    }).join('');
    return `<svg viewBox="0 0 ${L.largura} ${L.altura}" class="tv-planta" role="img" aria-label="Planta da loja com calor por gôndola"><rect x="1" y="1" width="${L.largura - 2}" height="${L.altura - 2}" rx="6" fill="none" stroke="var(--line-2)" stroke-width="2"/>${caixas}</svg>`;
  }

  function topGondolas(d) {
    const g = (d.mapa ? d.mapa.gondolas : []).filter(x => x.risco > 0 || x.vencidos).sort((a, b) => b.risco - a.risco).slice(0, 5), max = Math.max(1, ...g.map(x => x.risco));
    if (!g.length) return '<div class="tv-vazio">Nenhuma gôndola em risco.</div>';
    return g.map(x => `<div class="tv-bar"><span>Gôndola ${x.id}</span><div><i style="width:${Math.max(4, x.risco / max * 100)}%;background:${x.cor}"></i></div><b>${brlK(x.risco)}</b></div>`).join('');
  }

  function marcas(d) {
    const m = d.resumo.marcas.slice(0, 5), max = Math.max(1, ...m.map(x => x.perda));
    return m.map(x => `<div class="tv-bar"><span>${esc(x.marca)}</span><div><i style="width:${Math.max(4, x.perda / max * 100)}%"></i></div><b>${brlK(x.perda)}</b></div>`).join('');
  }

  function fazer(d) {
    if (!d.fila.length) return '<div class="tv-vazio">Nada urgente agora.</div>';
    return '<div class="tv-lista">' + d.fila.slice(0, 8).map(i => {
      const venc = i.dias <= 0;
      return `<div class="tv-fz"><i style="background:${i.cor}"></i><div><b>${esc(i.nome || i.ean)}</b><small>${esc(i.endereco || 'sem endereço')} · ${i.qtd} un. · ${venc ? 'venceu há ' + (-i.dias) + ' d' : 'vence em ' + i.dias + ' d'}</small></div><span class="tv-ac ${venc ? 'ret' : 'etq'}">${venc ? 'Retirar' : i.desconto ? 'Etiquetar ' + i.desconto + '%' : 'Frente'}</span></div>`;
    }).join('') + '</div>';
  }

  function rotina(d) {
    const h = d.hoje || { rondas: 0, conferencias: 0, auditorias: 0, a_processar: 0 };
    const sem = d.aud && d.aud.semanas ? d.aud.semanas.filter(s => s.acuracia !== null) : [], ult = sem[sem.length - 1];
    const cel = (n, r, cls = '') => `<div class="tv-c ${cls}"><b>${int(n)}</b><span>${r}</span></div>`;
    return `<div class="tv-rotina">${cel(h.rondas, h.rondas === 1 ? 'ronda hoje' : 'rondas hoje')}${cel(h.conferencias, h.conferencias === 1 ? 'conferência' : 'conferências')}${cel(h.auditorias, h.auditorias === 1 ? 'auditoria' : 'auditorias')}${cel(h.a_processar || 0, 'a processar', h.a_processar ? 'warn' : '')}</div>
      <div class="tv-conf">${ult ? `Confiança dos dados: <b>${ult.acuracia.toLocaleString('pt-BR')}%</b> na última auditoria` : 'Confiança dos dados: ainda sem auditoria concluída'}</div>`;
  }

  function corpo(d, anima) {
    const rv = anima ? ' reveal' : '';
    const card = (tit, sub, html, i, extra = '') => `<section class="tv-card${rv} ${extra}" style="--i:${i}"><header><h2>${tit}</h2><span>${sub}</span></header>${html}</section>`;
    return `${kpis(d)}
      <div class="tv-grade">
        ${card('Validade do estoque', 'lotes por status', rosca(d), 1, 'a')}
        ${card('Muro de validade', 'itens que vencem por mês', muro(d), 2, 'b')}
        ${card('Planta da loja', 'calor pelo pior status da gôndola', planta(d), 3, 'c')}
        ${card('Fazer agora', 'o que mais pesa, em ordem', fazer(d), 4, 'd')}
        ${card('Gôndolas em risco', 'valor em risco', topGondolas(d), 5, 'e')}
        ${card('Marcas que mais pesam', 'perda estimada', marcas(d), 6, 'f')}
        ${card('Rotina de hoje', 'rondas, conferências e auditorias', rotina(d), 7, 'g')}
      </div>`;
  }

  function html(d) {
    const agora = new Date();
    return `<div class="tv" id="tvRaiz">
      <header class="tv-top">
        <div class="tv-nome">${ico('map')}<span>Loja AP52 · São Pedro</span><small>Controle de validade</small></div>
        <div class="tv-rel"><b id="tvHora">${horaSP(agora)}</b><span id="tvData">${esc(agora.toLocaleDateString('pt-BR', { timeZone: SP, weekday: 'long', day: 'numeric', month: 'long' }))}</span><small id="tvAtu">Atualizado às ${horaSP(agora).slice(0, 5)}</small></div>
        <a class="btn tv-sair" href="#/geral">${ico('x')} Sair do modo TV</a>
      </header>
      <div id="tvCorpo" class="tv-corpo">${corpo(d, true)}</div>
    </div>`;
  }

  function inicia() {
    clearInterval(timer);
    let seg = 0, ocupado = false, ultima = horaSP(new Date()).slice(0, 5);
    timer = setInterval(async () => {
      const raiz = $('#tvRaiz');
      if (!raiz || !location.hash.startsWith('#/tv')) { clearInterval(timer); timer = null; return; }
      const agora = new Date();
      $('#tvHora').textContent = horaSP(agora);
      $('#tvData').textContent = agora.toLocaleDateString('pt-BR', { timeZone: SP, weekday: 'long', day: 'numeric', month: 'long' });
      if (++seg < 60 || ocupado) return;
      seg = 0; ocupado = true;
      const atu = $('#tvAtu');
      try {
        const d = await busca();
        if (!$('#tvRaiz') || !location.hash.startsWith('#/tv')) return;
        DADOS = d; $('#tvCorpo').innerHTML = corpo(d, false);
        ultima = horaSP(new Date()).slice(0, 5); atu.classList.remove('off'); atu.textContent = 'Atualizado às ' + ultima;
      } catch { if (atu) { atu.classList.add('off'); atu.textContent = 'Sem conexão: dados de ' + ultima; } }
      finally { ocupado = false; }
    }, 1000);
  }

  PAGINAS.tv = async () => { DADOS = await busca(); return html(DADOS); };
  PAGINAS.tv.ligar = () => { if ($('#tvRaiz')) inicia(); };
})();
