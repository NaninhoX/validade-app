// Briefing semanal de uma página: KPIs da semana contra a anterior, Pareto da perda, tendência de 4 semanas,
// decisões pedidas e pendências. Só usa números realmente registrados (snapshots_diarios e eventos de ronda).
const U = require('./util');
const S = require('./service');
const Snap = require('./snapshots');

const META_RONDAS = 6;          // dias de ronda esperados por semana (5 a 6; usamos 6 como referência)
const DIAS_SEM_RONDA = 14;
const r1 = n => +n.toFixed(1);

function addDias(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Variação de um indicador. `menorMelhor`: true quando cair é bom (vencido, risco, divergência).
function variacao(atual, anterior, menorMelhor = true) {
  if (atual === null || atual === undefined || anterior === null || anterior === undefined) {
    return { atual: atual ?? null, anterior: anterior ?? null, delta: null, delta_pct: null, sentido: null };
  }
  const delta = +(atual - anterior).toFixed(2);
  const delta_pct = anterior === 0 ? null : r1(delta / anterior * 100);
  const sentido = delta === 0 ? 'igual' : (delta < 0) === menorMelhor ? 'melhor' : 'pior';
  return { atual, anterior, delta, delta_pct, sentido };
}

// Pareto: top N por perda; pct e acum são sobre a perda total de TODOS os itens (não só dos N).
function pareto(itens, n = 5) {
  const ok = itens.filter(i => (i.perda || 0) > 0).sort((a, b) => b.perda - a.perda || String(a.nome).localeCompare(String(b.nome)));
  const total = ok.reduce((s, i) => s + i.perda, 0);
  let acc = 0;
  const linhas = ok.slice(0, n).map(i => {
    acc += i.perda;
    return { ...i, perda: +i.perda.toFixed(2), pct: r1(i.perda / total * 100), acum: r1(acc / total * 100) };
  });
  return { total: +total.toFixed(2), itens: linhas, outros: Math.max(0, ok.length - linhas.length) };
}

// Snapshot mais recente com data em (alvo-7, alvo]; null se não houver (não inventa).
function pontoEm(snaps, alvo) {
  const ini = addDias(alvo, -7);
  let achado = null;
  for (const s of snaps) if (s.data <= alvo && s.data > ini) achado = s;
  return achado;
}

const lista = nomes => nomes.length <= 1 ? nomes.join('') : nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
const brl0 = n => 'R$ ' + Math.round(n).toLocaleString('pt-BR');

// Frases de "Decisão pedida", escritas a partir dos números (sem texto fixo quando não há dado).
function decisoes({ marcas, gondolas, kpis, rondas, pendentes }) {
  const out = [];
  if (marcas.total > 0 && marcas.itens.length) {
    const top = marcas.itens.slice(0, 3);
    const share = top[top.length - 1].acum;
    const nomes = top.map(m => m.nome);
    out.push(share >= 40
      ? `${top.length === 1 ? '1 marca concentra' : top.length + ' marcas concentram'} ${share.toLocaleString('pt-BR')}% da perda: rever o pedido de ${lista(nomes)}.`
      : `A perda está espalhada: as ${top.length} maiores marcas somam só ${share.toLocaleString('pt-BR')}%. Rever o pedido de ${lista(nomes)} mesmo assim.`);
  }
  if (gondolas.total > 0 && gondolas.itens.length) {
    const g = gondolas.itens[0];
    if (g.pct >= 20) out.push(`${g.nome} concentra ${g.pct.toLocaleString('pt-BR')}% da perda: priorizar a retirada e a etiquetagem ali.`);
  }
  const v = kpis.vencido_valor;
  if (v.delta !== null && v.delta > 0) out.push(`Vencido em estoque subiu ${brl0(v.delta)} na semana: reforçar a retirada para RMA na ronda.`);
  else if (v.atual > 0 && v.delta === null) out.push(`Há ${brl0(v.atual)} vencido em estoque: definir quem retira e até quando.`);
  if (rondas.dias_este < META_RONDAS) out.push(`Só ${rondas.dias_este} de ${META_RONDAS} rondas na semana: definir responsável pelos dias sem ronda.`);
  const dv = kpis.divergencia.atual;
  if (dv !== null && dv >= 10) out.push(`Divergência da ronda em ${dv.toLocaleString('pt-BR')}%: revisar o recebimento e o endereçamento.`);
  if (pendentes.total > 0) out.push(`${pendentes.total} ${pendentes.total === 1 ? 'gôndola sem ronda' : 'gôndolas sem ronda'} há mais de ${DIAS_SEM_RONDA} dias: escalar para cobrir esta semana.`);
  return out;
}

function rondasDaSemana(painel, hoje) {
  const j = (de, ate) => {
    const dias = painel.filter(d => d.dia >= de && d.dia <= ate && d.lotes > 0);
    const lotes = dias.reduce((s, d) => s + d.lotes, 0);
    const div = dias.reduce((s, d) => s + d.corrigido + d.nao_achei, 0);
    return { dias: dias.length, lotes, divergencia: lotes ? r1(div / lotes * 100) : null };
  };
  return { este: j(addDias(hoje, -6), hoje), anterior: j(addDias(hoje, -13), addDias(hoje, -7)) };
}

async function briefingSemanal(db) {
  const hoje = U.hojeISO();
  const [todos, m, painel] = await Promise.all([S.lotesAtivos(db), S.mapa(db), S.rondaPainel(db, 14)]);
  await Snap.registrarSeguro(db, todos, hoje);
  const snaps = await Snap.listar(db, addDias(hoje, -35));
  const primeiro = (await db.get('SELECT MIN(data) AS d FROM snapshots_diarios'))?.d || null;

  const atual = pontoEm(snaps, hoje);
  const ant = pontoEm(snaps, addDias(hoje, -7));
  const rd = rondasDaSemana(painel, hoje);
  const kpis = {
    vencido_valor: variacao(atual?.vencido_valor ?? null, ant?.vencido_valor ?? null),
    vencido_lotes: variacao(atual?.vencido_lotes ?? null, ant?.vencido_lotes ?? null),
    valor_risco: variacao(atual?.valor_risco ?? null, ant?.valor_risco ?? null),
    rondas: variacao(rd.este.dias, rd.anterior.dias, false),
    divergencia: variacao(rd.este.divergencia, rd.anterior.divergencia),
  };

  const tendencia = [3, 2, 1, 0].map(k => {
    const alvo = addDias(hoje, -7 * k);
    const s = pontoEm(snaps, alvo);
    return { semana: k === 0 ? 'hoje' : `-${k * 7} d`, alvo, data: s ? s.data : null, valor: s ? s.vencido_valor : null };
  });

  const porMarca = new Map();
  for (const l of todos) {
    const k = l.marca || '(sem marca)';
    porMarca.set(k, (porMarca.get(k) || 0) + (l.perda || 0));
  }
  const nomeG = id => (m.gondolas_cfg && m.gondolas_cfg[id] && m.gondolas_cfg[id].nome) || `Gôndola ${id}`;
  const marcas = pareto([...porMarca].map(([nome, perda]) => ({ nome, perda })));
  const gondolas = pareto(m.gondolas.map(g => ({ id: g.id, nome: nomeG(g.id), perda: g.perda })));

  const pend = m.gondolas.filter(g => g.lotes > 0 && (g.nunca_contada || (g.dias_sem_ronda ?? 0) > DIAS_SEM_RONDA))
    .map(g => ({ id: g.id, nome: nomeG(g.id), dias_sem_ronda: g.nunca_contada ? null : g.dias_sem_ronda, nunca: !!g.nunca_contada, valor: g.valor }))
    .sort((a, b) => (b.nunca - a.nunca) || ((b.dias_sem_ronda ?? 0) - (a.dias_sem_ronda ?? 0)) || b.valor - a.valor);
  const pendentes = { total: pend.length, limite_dias: DIAS_SEM_RONDA, itens: pend.slice(0, 10) };

  const rondas = { dias_este: rd.este.dias, dias_anterior: rd.anterior.dias, meta: META_RONDAS };
  return {
    hoje,
    periodo: { de: addDias(hoje, -6), ate: hoje },
    comparacao: { snapshot_atual: atual?.data ?? null, snapshot_anterior: ant?.data ?? null },
    historico: { inicio: primeiro, completo: !!primeiro && primeiro <= addDias(hoje, -21), semanas_com_dado: tendencia.filter(t => t.valor !== null).length },
    kpis, rondas, tendencia, marcas, gondolas, pendentes,
    decisoes: decisoes({ marcas, gondolas, kpis, rondas, pendentes }),
  };
}

module.exports = { briefingSemanal, variacao, pareto, decisoes, pontoEm, addDias, META_RONDAS, DIAS_SEM_RONDA };
