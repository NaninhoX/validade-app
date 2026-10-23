'use strict';
const S = { login: false, usuario: null, admin: true, op: 'LOCAL', ops: [], cfg: null, resumo: null };
const ROTAS = {
  geral: { titulo: 'Visão geral', sub: () => `Hoje, ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}` },
  mapa: { titulo: 'Mapa da loja', sub: () => 'Calor por gôndola, lado e prateleira' },
  coletor: { titulo: 'Coletor', sub: () => 'Receber, conferir, dar baixa e buscar' },
  estoque: { titulo: 'Estoque', sub: () => 'Todos os lotes em loja' },
  mov: { titulo: 'Movimentações', sub: () => 'Tudo que o coletor e o painel registraram' },
  config: { titulo: 'Configurações', sub: () => 'Regras, equipe e dados' },
  conferencias: { titulo: 'Conferências', sub: () => 'Bipagem em rajada: recebimento, validade e contagem' },
  conferencia: { titulo: 'Conferência', sub: () => 'Leia os códigos de barras em sequência' },
  tv: { titulo: 'Modo TV', sub: () => 'Painel para deixar aberto numa tela da loja' },
  folha: { titulo: 'Importar folha', sub: () => 'Foto da folha de papel para lançar lotes' },
};
const view = $('#view');
let token = 0;

// ---------- diálogo ----------
function dialogo({ titulo, sub, campos, ok = 'Confirmar' }) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    $('#dlgTitulo').textContent = titulo; $('#dlgSub').textContent = sub || ''; $('#dlgOk').textContent = ok;
    $('#dlgCampos').innerHTML = campos.map(c => `<div class="field"><label class="f" for="d_${c.id}">${esc(c.label)}</label>${
      c.tipo === 'select' ? `<select id="d_${c.id}">${c.opcoes.map(o => `<option>${esc(o)}</option>`).join('')}</select>`
        : `<input id="d_${c.id}" type="${c.tipo || 'text'}" ${c.min !== undefined ? `min="${c.min}"` : ''} value="${esc(c.valor ?? '')}" ${c.inputmode ? `inputmode="${c.inputmode}"` : ''} autocomplete="off">`}${c.dica ? `<div class="xs muted" id="h_${c.id}" style="margin-top:5px"></div>` : ''}</div>`).join('');
    campos.filter(c => c.dica).forEach(c => { const el = $('#d_' + c.id), h = $('#h_' + c.id); const f = () => { h.textContent = c.dica(el.value); }; el.addEventListener('input', f); f(); });
    const fim = v => { dlg.close(); resolve(v); };
    $('#dlgCancel').onclick = () => fim(null);
    $('#dlgForm').onsubmit = e => { e.preventDefault(); fim(Object.fromEntries(campos.map(c => [c.id, $('#d_' + c.id).value]))); };
    dlg.addEventListener('cancel', () => resolve(null), { once: true });
    dlg.showModal();
    const f0 = $('#d_' + campos[0].id); f0.focus(); if (f0.select) f0.select();
  });
}

async function enviar(body, msg) {
  try {
    const r = await api('/api/leituras', { method: 'POST', body: { client_id: uuid(), operador: S.op, ...body } });
    toast(msg + (r.avisos?.length ? ' — ' + r.avisos.join(' · ') : ''), 'ok', 4500);
    return true;
  } catch (e) { toast(e.message, 'bad', 5000); return false; }
}

// ---------- casca ----------
function pintaNav(nome) {
  if (nome === 'conferencia') nome = 'conferencias';
  $$('.nav[data-r], .sheet-item[data-r]').forEach(a => { if (a.dataset.r === nome) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const sec = ['mov', 'config', 'conferencias'].includes(nome);
  const mb = $('#maisBtn'); if (sec) mb.setAttribute('aria-current', 'page'); else mb.removeAttribute('aria-current');
}
function fechaMais() { $('#maisSheet').hidden = true; $('#maisBack').hidden = true; $('#maisBtn').setAttribute('aria-expanded', 'false'); }
function alternaMais() { const abre = $('#maisSheet').hidden; $('#maisSheet').hidden = !abre; $('#maisBack').hidden = !abre; $('#maisBtn').setAttribute('aria-expanded', String(abre)); }

async function rota() {
  const h = location.hash.replace(/^#\/?/, '') || 'geral';
  const [caminho, qs] = h.split('?');
  const [nome, param] = caminho.split('/');      // #/conferencia/12 => nome 'conferencia', id 12
  const r = ROTAS[nome] ? nome : 'geral';
  const q = new URLSearchParams(qs || '');
  if (param) q.set('id', param);
  const meu = ++token;
  pintaNav(r); fechaMais();
  document.body.classList.toggle('modo-tv', r === 'tv');
  $('#voltar').hidden = r === 'geral';
  window.scrollTo(0, 0);
  $('#tTitulo').textContent = ROTAS[r].titulo; $('#tSub').textContent = ROTAS[r].sub();
  document.title = ROTAS[r].titulo + ' · Controle de Validade';
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
  view.innerHTML = skeleton(r);
  try {
    const html = await PAGINAS[r](q, meu);
    if (meu !== token) return;
    if (typeof html === 'string') view.innerHTML = html;
    if (PAGINAS[r].ligar) PAGINAS[r].ligar(q);
  } catch (e) {
    if (meu === token) {
      view.innerHTML = `<div class="callout warn">${ico('alert')}<div style="flex:1"><b>${e.rede ? 'Sem conexão' : 'Não consegui carregar'}</b><div class="small" style="margin:4px 0 12px">${esc(e.message)}</div><button id="tentar">${ico('refresh')} Tentar de novo</button></div></div>`;
      const b = $('#tentar'); if (b) b.addEventListener('click', rota);
    }
  }
}
const skeleton = r => r === 'mapa' ? '' : `<div class="kpis">${'<div class="card skeleton" style="height:104px"></div>'.repeat(4)}</div><div class="card skeleton" style="height:320px;margin-top:18px"></div>`;
window.addEventListener('hashchange', rota);

async function carregaResumo() {
  S.resumo = await api('/api/resumo');
  const venc = S.resumo.por_status[0]?.lotes || 0;
  const b = $('#nVenc'); b.hidden = !venc; b.textContent = venc;
  return S.resumo;
}

// ---------- visão geral ----------
function donut(por) {
  const R = 70, C = 2 * Math.PI * R, total = por.reduce((a, s) => a + s.lotes, 0) || 1;
  let acc = 0;
  const segs = por.filter(s => s.lotes).map(s => { const len = s.lotes / total * C; const o = { s, len: Math.max(0, len - 2.5), off: acc }; acc += len; return o; });
  return `<div class="donut"><svg viewBox="0 0 190 190" role="img" aria-label="Distribuição dos lotes por status">
    <circle cx="95" cy="95" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="20"/>
    ${segs.map(g => `<circle class="seg-arc" cx="95" cy="95" r="${R}" stroke="${esc(g.s.cor)}" stroke-dasharray="0 ${C}" stroke-dashoffset="${-g.off}" data-len="${g.len}" data-c="${C}" data-status="${esc(g.s.status)}"><title>${esc(g.s.status)}: ${g.s.lotes} lotes</title></circle>`).join('')}
  </svg><div class="center"><div><b data-count="${total}">0</b><div class="xs muted">lotes</div></div></div></div>`;
}

// Muro de validade: barras por mês, em itens (unidades) ou em R$.
let MURO = { dados: [], cor: '#9f1239' };
const muroMet = () => (lsGet('muroMet', 'qtd') === 'valor' ? 'valor' : 'qtd');
const muroSub = () => (muroMet() === 'valor' ? 'valor (R$) que vence por mês' : 'itens (unidades) que vencem por mês');
function muroBarras() {
  const met = muroMet(), d = MURO.dados;
  const max = Math.max(1, ...d.map(m => m[met]));
  const corMes = (k, i) => (k === 'Vencidos' ? MURO.cor : k === 'Depois' ? '#22c55e' : i <= 1 ? '#f97316' : i === 2 ? '#eab308' : i <= 4 ? '#3b82f6' : '#06b6d4');
  const nomeMes = k => (k === 'Vencidos' ? 'Venc.' : k === 'Depois' ? '12m+' : new Date(k + '-15T12:00:00').toLocaleDateString('pt-BR', { month: 'short' }).replace('.', ''));
  const rot = v => (met === 'valor' ? (v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : Math.round(v)) : v >= 10000 ? Math.round(v / 1000) + 'k' : int(v));
  return d.map((m, i) => `<div class="b" title="${esc(nomeMes(m.chave))}: ${int(m.qtd)} itens · ${brl(m.valor)} · ${m.lotes} lotes"><span class="v">${rot(m[met])}</span><div class="col" style="height:${Math.max(1.5, m[met] / max * 100)}%;--c:${corMes(m.chave, i - 1)};--i:${i}"></div><span class="m">${esc(nomeMes(m.chave))}</span></div>`).join('');
}

const PAGINAS = {};
PAGINAS.geral = async () => {
  const [res, fila, mapa, cfg, placar] = await Promise.all([carregaResumo(), api('/api/fila?limite=8'), api('/api/mapa'), api('/api/config'), S.admin ? api('/api/placar').catch(() => []) : []]);
  S.cfg = cfg;
  const t = res.totais, por = res.por_status, q = res.qualidade;
  MURO = { dados: res.muro, cor: por[0].cor };
  const gRisco = [...mapa.gondolas].sort((a, b) => b.risco - a.risco).slice(0, 5);
  const f = cfg.faixas;
  const f30 = f.find(x => x.ate === 30), f90 = f.find(x => x.ate === 90);
  const kpi = (i, rot, icone, valor, fmt, dica, cls = '', cor = 'var(--accent)') => `<div class="card kpi reveal ${cls}" style="--i:${i}"><div class="glow" style="background:${cor}"></div><div class="lbl">${ico(icone)}${rot}</div><div class="val" data-count="${valor}" data-fmt="${fmt}">0</div><div class="hint">${dica}</div></div>`;
  return `
  <div class="kpis">
    ${kpi(0, 'Valor em estoque', 'box', t.valor, 'brl', `${int(t.itens)} itens · ${t.lotes} lotes`)}
    ${kpi(1, 'Valor em risco', 'flame', t.valor_em_risco, 'brl', 'em alerta ou vencido', 'bad', '#e11d48')}
    ${kpi(2, 'Perda potencial', 'trend', t.perda_potencial, 'brl', 'se vender com o desconto da regra', '', '#f97316')}
    ${kpi(3, 'Perda potencial evitada', 'check', res.evitada.evitada, 'brl', res.evitada.unidades ? `${int(res.evitada.unidades_risco)} un. vendidas em alerta · ${res.evitada.dias} dias` : 'registre as vendas em Baixa → Venda', 'ok', '#16a34a')}
    ${kpi(4, 'Vencidos em loja', 'alert', por[0].lotes, 'int', por[0].lotes ? `${brl(por[0].valor)} para retirar` : 'nada vencido', por[0].lotes ? 'bad' : '', '#9f1239')}
  </div>
  <div class="grid cols-2" style="margin-top:18px">
    <div class="card reveal" style="--i:4"><div class="head"><h2>Validade do estoque</h2><span class="sub">toque numa fatia para filtrar</span></div>
      <div class="donut-wrap">${donut(por)}
        <div class="legend">${por.map(s => `<div class="row click" data-status="${esc(s.status)}"><span class="dot" style="--c:${esc(s.cor)}"></span><div><div>${esc(s.status)}</div><div class="xs muted">${brl(s.valor)}</div></div><b class="num" style="font-size:17px">${s.lotes}</b></div>`).join('')}</div></div></div>
    <div class="card reveal" style="--i:5"><div class="head"><h2>Muro de validade</h2>
        <div class="seg" id="muroMet" role="group" aria-label="Medida do muro"><button data-met="qtd" aria-pressed="${muroMet() === 'qtd'}">Itens</button><button data-met="valor" aria-pressed="${muroMet() === 'valor'}">R$</button></div></div>
      <div class="xs muted" id="muroSub" style="margin:-6px 0 4px">${muroSub()}</div>
      <div class="muro" id="muro">${muroBarras()}</div></div>
  </div>
  <div class="grid cols-2" style="margin-top:18px">
    <div class="card reveal" style="--i:6"><div class="head"><h2>Fazer hoje</h2><a href="#/estoque" class="small">Ver estoque →</a></div>
      ${fila.length ? fila.map(r => `<div class="row click" data-q="${esc(r.ean)}"><span class="dot" style="--c:${esc(r.cor)}"></span>
        <div style="min-width:0"><div class="pname" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.nome || r.ean)}</div><div class="xs muted">${addr(r.endereco, r.endereco_ok)} lote ${esc(r.lote)} · ${r.qtd} un · ${esc(r.acao_sugerida)}</div></div>
        <div style="text-align:right">${pill(r.status, r.cor)}<div class="xs muted" style="margin-top:3px">${r.dias <= 0 ? 'venceu há ' + (-r.dias) + ' d' : 'em ' + r.dias + ' d'}</div></div></div>`).join('') : '<p class="muted">Nada urgente.</p>'}</div>
    <div class="grid" style="align-content:start">
      <div class="card reveal" style="--i:7"><div class="head"><h2>Regra de prevenção vigente</h2></div>
        <div style="display:grid;gap:10px">
          <div class="row" style="grid-template-columns:auto 1fr;border:0;padding:0"><span class="pill" style="--c:${esc(f30.cor)}">até ${f30.ate} dias</span><div><b>${f30.desconto}%</b> em tudo</div></div>
          <div class="row" style="grid-template-columns:auto 1fr;border:0;padding:0"><span class="pill" style="--c:${esc(f90.cor)}">até ${f90.ate} dias</span><div>Ração seca e úmida <b>${f90.desconto_racao}%</b> · demais itens <b>${f90.desconto}%</b></div></div>
        </div></div>
      <div class="card reveal" style="--i:8"><div class="head"><h2>Gôndolas que pedem atenção</h2><a href="#/mapa" class="small">Abrir mapa →</a></div>
        ${gRisco.map(g => `<a class="row click" href="#/mapa" data-g="${g.id}" style="color:inherit"><span class="dot" style="--c:${esc(g.cor || '#94a3b8')}"></span><div><div class="pname">Gôndola ${g.id}</div><div class="xs muted">${g.vencidos} vencidos · ${g.nunca_contada ? 'nunca contada' : g.dias_sem_ronda !== null ? 'ronda há ' + g.dias_sem_ronda + ' d' : ''}</div></div><b class="num">${brlK(g.risco)}</b></a>`).join('') || '<p class="muted">Sem dados.</p>'}</div>
    </div>
  </div>
  <div class="card reveal" id="cardCausas" style="--i:9;margin-top:18px"></div>
  <div id="audCard" style="margin-top:18px"></div>
  <div id="hojeCard" style="margin-top:18px"></div>
  <div class="grid cols-2" style="margin-top:18px">
    <div class="card reveal" style="--i:9"><div class="head"><h2>Marcas com maior perda potencial</h2></div>
      ${(() => { const m = Math.max(1, ...res.marcas.map(x => x.perda)); return res.marcas.slice(0, 7).map(x => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(x.marca)}</span><b class="num">${brl(x.perda)}</b></div><div class="meter" style="margin-top:6px"><i style="width:${x.perda / m * 100}%"></i></div></div>`).join(''); })()}</div>
    ${placar.length ? `<div class="card reveal" style="--i:9"><div class="head"><div><h2>Responsáveis</h2><div class="sub">Só administradores veem · ronda dos últimos 7 dias</div></div><a href="#/config" class="small">Editar →</a></div>
      ${placar.map(p => `<div class="row" style="grid-template-columns:auto minmax(0,1fr) auto"><div class="avatar" style="width:34px;height:34px">${esc(p.nome.slice(0, 1))}</div>
        <div style="min-width:0"><div class="pname">${esc((n => n.charAt(0) + n.slice(1).toLowerCase())(p.nome))} <span class="xs muted">setor${p.setores.length > 1 ? 'es' : ''} ${p.setores.join(', ')}</span></div>
        <div class="xs muted">${p.vencidos ? `<b style="color:var(--bad)">${p.vencidos} vencido${p.vencidos > 1 ? 's' : ''}</b> · ` : ''}${p.nunca_contadas ? p.nunca_contadas + ' nunca contada' + (p.nunca_contadas > 1 ? 's' : '') : p.pior_dias_sem_ronda !== null ? 'pior: ronda há ' + p.pior_dias_sem_ronda + ' d' : 'sem estoque'} · ${p.ronda7_lotes ? `${p.ronda7_lotes} conferidos, ${String(p.ronda7_divergencia).replace('.', ',')}% não bateram` : 'sem ronda na semana'}</div></div>
        <b class="num">${brlK(p.risco)}</b></div>`).join('')}</div>` : ''}
    <div class="card reveal" style="--i:10"><div class="head"><h2>Qualidade dos dados</h2></div>
      ${[[q.vencidos_em_estoque, 'lotes vencidos ainda no estoque', 'retirar e dar baixa'], [q.endereco_fora_padrao, 'lotes com endereço fora do padrão', q.enderecos_fora_padrao.map(e => e.endereco).join(', ') || ''], [q.produtos_sem_preco, q.produtos_sem_preco === 1 ? 'produto em estoque sem preço' : 'produtos em estoque sem preço', 'toque para informar no Estoque', '#/estoque?sempreco=1'], [q.sem_endereco, 'lotes sem endereço', ''], [q.sem_cadastro, 'lotes de EAN sem cadastro', '']]
        .map(([n, a, b, link]) => `<${link && n ? `a href="${link}"` : 'div'} class="row${link && n ? ' click' : ''}" style="grid-template-columns:auto 1fr;color:inherit;opacity:${n ? 1 : .5}"><b class="num" style="font-size:20px;min-width:38px;color:${n ? 'var(--warn)' : 'var(--good)'}">${n}</b><div><div>${a}</div>${b && n ? `<div class="xs muted">${esc(b)}</div>` : ''}</div></${link && n ? 'a' : 'div'}>`).join('')}</div>
  </div>`;
};
PAGINAS.geral.ligar = () => {
  Causa.montaCard($('#cardCausas'));
  Auditoria.cartao($('#audCard'));
  Conferencias.cartaoHoje($('#hojeCard'));
  $$('[data-count]').forEach(el => contar(el, +el.dataset.count, el.dataset.fmt === 'brl' ? brl : int));
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.seg-arc').forEach(c => { c.style.strokeDasharray = `${c.dataset.len} ${c.dataset.c - c.dataset.len}`; })));
  $$('[data-status]').forEach(el => el.addEventListener('click', () => { location.hash = '#/estoque?status=' + encodeURIComponent(el.dataset.status); }));
  $$('.row[data-q]').forEach(el => el.addEventListener('click', () => { location.hash = '#/estoque?q=' + encodeURIComponent(el.dataset.q); }));
  const seg = $('#muroMet');
  if (seg) seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-met]'); if (!b) return;
    lsSet('muroMet', b.dataset.met);
    $$('#muroMet button').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#muroSub').textContent = muroSub(); $('#muro').innerHTML = muroBarras();
  });
};

// ---------- coletor ----------
PAGINAS.coletor = async () => Coletor.html();
PAGINAS.coletor.ligar = () => Coletor.ligar();
PAGINAS.conferencias = async () => { await Conferencias.lista(view); return null; };
PAGINAS.conferencia = async q => { await Conferencias.burst(view, q.get('id')); return null; };
PAGINAS.folha = async () => Folha.html();
PAGINAS.folha.ligar = () => Folha.ligar();

// ---------- mapa ----------
PAGINAS.mapa = async () => { await Mapa.render(view, { admin: S.admin }); return null; };

// ---------- estoque ----------
const E = { q: '', status: '', gondola: '', marca: '', offset: 0, total: 0, marcas: [] };
PAGINAS.estoque = async q => {
  E.q = q.get('q') || ''; E.status = q.get('status') || ''; E.gondola = q.get('gondola') || ''; E.marca = q.get('marca') || ''; E.sempreco = q.get('sempreco') === '1' ? '1' : '';
  const [res, cfg, todas, gcfg] = await Promise.all([S.resumo ? Promise.resolve(S.resumo) : carregaResumo(), S.cfg ? Promise.resolve(S.cfg) : api('/api/config'), api('/api/lotes?limite=1'), api('/api/gondolas').catch(() => ({}))]);
  S.cfg = cfg; E.marcas = todas.marcas;
  const gond = [...new Set([...Array.from({ length: 19 }, (_, i) => i + 1), ...Object.keys(gcfg).map(Number)])].sort((a, b) => a - b);
  return `<div class="grid" style="gap:14px">
    <div class="reveal filters">
      <div class="search"><span id="ss"></span><input id="fq" type="search" placeholder="Buscar produto, EAN, lote ou endereço" value="${esc(E.q)}" aria-label="Buscar"></div>
      <select id="fgond" aria-label="Gôndola"><option value="">Todas as gôndolas</option>${gond.map(g => `<option ${E.gondola == g ? 'selected' : ''} value="${g}">${g} · ${esc((gcfg[g] && gcfg[g].nome) || 'Gôndola')}</option>`).join('')}</select>
      <select id="fmarca" aria-label="Marca"><option value="">Todas as marcas</option>${E.marcas.map(m => `<option ${E.marca === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <select id="fpreco" aria-label="Preço"><option value="">Com e sem preço</option><option value="1" ${E.sempreco ? 'selected' : ''}>Só sem preço</option></select>
    </div>
    <div class="seg scrollx reveal" style="--i:1" id="fst"><button data-st="" aria-pressed="${E.status === ''}">Todos</button>${res.por_status.map(s => `<button data-st="${esc(s.status)}" aria-pressed="${E.status === s.status}">${esc(s.status)} <span class="faint">${s.lotes}</span></button>`).join('')}</div>
    <div class="card flush reveal" style="--i:2"><div class="head"><h2 id="estTit">Estoque</h2><span class="sub" id="estInfo"></span></div>
      <div class="scroll" style="max-height:calc(100vh - 330px);margin-top:12px"><table class="resp"><thead><tr><th>Status</th><th>Produto</th><th>Lote</th><th class="num">Qtd</th><th>Validade</th><th class="num">Dias</th><th>Endereço</th><th class="num">Preço</th><th class="num">Oferta</th><th></th></tr></thead><tbody id="est"></tbody></table></div>
      <div style="padding:14px 20px"><button id="maisEst" hidden>Carregar mais</button></div></div>
  </div>`;
};
PAGINAS.estoque.ligar = () => {
  $('#ss').innerHTML = ico('search');
  const recarrega = () => carregaEstoque(true);
  let deb;
  $('#fq').addEventListener('input', e => { clearTimeout(deb); deb = setTimeout(() => { E.q = e.target.value.trim(); recarrega(); }, 250); });
  $('#fgond').addEventListener('change', e => { E.gondola = e.target.value; recarrega(); });
  $('#fmarca').addEventListener('change', e => { E.marca = e.target.value; recarrega(); });
  $('#fpreco').addEventListener('change', e => { E.sempreco = e.target.value; recarrega(); });
  $('#fst').addEventListener('click', e => { const b = e.target.closest('button[data-st]'); if (!b) return; E.status = b.dataset.st; $$('#fst button').forEach(x => x.setAttribute('aria-pressed', x === b)); recarrega(); });
  $('#maisEst').addEventListener('click', () => carregaEstoque(false));
  $('#est').addEventListener('click', acaoLote);
  recarrega();
};

async function carregaEstoque(reset) {
  if (reset) { E.offset = 0; $('#est').innerHTML = ''; }
  const p = new URLSearchParams({ offset: E.offset, limite: 100 });
  for (const k of ['q', 'status', 'gondola', 'marca', 'sempreco']) if (E[k]) p.set(k, E[k]);
  const r = await api('/api/lotes?' + p);
  E.total = r.total;
  $('#est').insertAdjacentHTML('beforeend', r.itens.map((l, i) => `
    <tr style="animation:rise .35s var(--ease) both;animation-delay:${Math.min(i, 14) * 25}ms"><td class="c-st">${pill(l.status, l.cor)}</td>
    <td class="c-pr"><div class="pname">${esc(l.nome || '(sem cadastro)')}</div><div class="xs muted">${esc(l.ean)}${l.marca ? ' · ' + esc(l.marca) : ''}</div></td>
    <td class="c-lt" data-l="Lote">${esc(l.lote)}</td><td class="c-qt num" data-l="Qtd">${l.qtd}</td><td class="c-vl nowrap" data-l="Validade">${brData(l.validade)}</td><td class="c-dd num" data-l="Dias">${l.dias}</td><td class="c-en">${addr(l.endereco, l.endereco_ok)}</td>
    <td class="c-pc num" data-l="Preço">${l.preco === null || l.preco === undefined ? `<button class="sm" data-act="preco" data-id="${l.id}">＋ Preço</button>` : brl(l.preco)}</td><td class="c-of num">${l.desconto ? `<b>${l.desconto}%</b>${l.preco_desc !== null ? `<div class="xs muted">${brl(l.preco_desc)}</div>` : ''}` : '—'}</td>
    <td class="c-ac nowrap"><button class="icon subtle sm" data-act="baixa" data-id="${l.id}" title="Dar baixa">${ico('minus')}</button><button class="icon subtle sm" data-act="ajuste" data-id="${l.id}" title="Ajustar quantidade">${ico('edit')}</button><button class="icon subtle sm" data-act="mover" data-id="${l.id}" title="Mover de endereço">${ico('move')}</button></td></tr>`).join('')|| (reset ? '<tr><td colspan="10" class="muted" style="padding:32px;text-align:center">Nenhum lote com esses filtros.</td></tr>' : ''));
  E.offset += r.itens.length;
  $('#estInfo').textContent = `${int(Math.min(E.offset, E.total))} de ${int(E.total)} lotes`;
  $('#maisEst').hidden = E.offset >= E.total;
  window.__lotes = Object.assign(window.__lotes || {}, Object.fromEntries(r.itens.map(l => [l.id, l])));
}

async function acaoLote(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const l = window.__lotes[b.dataset.id];
  const nome = `${l.nome || l.ean} · lote ${l.lote} · ${l.endereco || 'sem endereço'}`;
  let ok = false;
  if (b.dataset.act === 'preco') {
    const d = await dialogo({ titulo: 'Preço de venda', sub: l.nome || l.ean, campos: [{ id: 'p', label: 'Preço (R$)', inputmode: 'decimal' }] });
    if (!d) return;
    const pv = parsePreco(d.p);
    if (pv === null || Number.isNaN(pv)) return toast('Preço inválido. Digite só números, ex.: 39,90 ou 1.299,90', 'bad', 4000);
    try { await api('/api/produtos', { method: 'POST', body: { ean: l.ean, nome: l.nome || l.ean, preco: pv } }); toast('Preço salvo', 'ok'); ok = true; }
    catch (er) { return toast(er.message, 'bad', 5000); }
  } else if (b.dataset.act === 'baixa') {
    const d = await Causa.dialogoBaixa({ sub: `${nome} — saldo ${l.qtd}`, saldo: l.qtd, motivos: S.cfg.motivos_baixa, vencido: l.dias <= 0 });
    if (d) ok = await enviar({ tipo: 'BAIXA', lote_id: l.id, qtd: d.qtd, motivo: d.motivo, causa: d.causa }, 'Baixa registrada');
  } else if (b.dataset.act === 'ajuste') {
    const d = await dialogo({ titulo: 'Ajustar quantidade', sub: `${nome} — saldo ${l.qtd}`, campos: [{ id: 'qtd', label: 'Quantidade contada', tipo: 'number', min: 0, valor: l.qtd, inputmode: 'numeric' }] });
    if (d) ok = await enviar({ tipo: 'AJUSTE', lote_id: l.id, qtd: d.qtd, motivo: 'Ajuste pelo painel' }, 'Quantidade ajustada');
  } else {
    const d = await dialogo({ titulo: 'Mover de endereço', sub: `${nome} — saldo ${l.qtd}`, campos: [
      { id: 'qtd', label: 'Quantidade a mover', tipo: 'number', min: 1, valor: l.qtd, inputmode: 'numeric' },
      { id: 'dest', label: 'Endereço de destino (gôndola-lado-prateleira)', dica: v => (parseEndereco(v).valido ? descEndereco(v) : v ? 'Use o padrão 1-B-3 (lado A ou B, prateleira 1–5) ou 1-F / 1-C para pontas' : '') }] });
    if (d) ok = await enviar({ tipo: 'TRANSFERENCIA', lote_id: l.id, qtd: d.qtd, endereco_destino: d.dest }, 'Lote movido');
  }
  if (ok) { carregaResumo(); const n = E.offset; E.offset = 0; $('#est').innerHTML = ''; do { await carregaEstoque(false); } while (E.offset < Math.min(n, E.total) && E.offset > 0); }
}


// ---------- movimentações ----------
const TIPO_TXT = { IMPORT: 'Carga inicial', RECEBIMENTO: 'Recebimento', CONTAGEM: 'Contagem', AJUSTE: 'Ajuste', BAIXA: 'Baixa', ETIQUETA: 'Etiqueta de desconto', TRANSF_SAIDA: 'Transferência (saída)', TRANSF_ENTRADA: 'Transferência (entrada)' };
const TIPO_COR = { IMPORT: '#8e8e93', RECEBIMENTO: '#22c55e', CONTAGEM: '#2f7de1', AJUSTE: '#f59e0b', BAIXA: '#e11d48', ETIQUETA: '#14b8a6', TRANSF_SAIDA: '#8b5cf6', TRANSF_ENTRADA: '#8b5cf6' };
PAGINAS.mov = async () => {
  const ev = await api('/api/eventos?limite=300');
  return `<div class="card reveal"><div class="tl">${ev.map((e, i) => `<div class="ev" style="--c:${TIPO_COR[e.tipo] || '#8e8e93'};${e.desfeito ? 'opacity:.45' : ''};${i < 12 ? `animation:rise .4s var(--ease) both;animation-delay:${i * 35}ms` : ''}">
    <div style="display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap"><div><b>${esc(TIPO_TXT[e.tipo] || e.tipo)}</b>${e.historico ? ' <span class="xs faint">(histórico)</span>' : ''} · ${esc(e.nome || e.ean)}</div><div class="xs muted">${brDataHora(e.ts)} · ${esc(e.operador || '')}</div></div>
    <div class="xs muted" style="margin-top:2px">${e.lote ? 'lote ' + esc(e.lote) + ' · ' : ''}${e.endereco ? addr(e.endereco, U_ok(e.endereco)) + ' · ' : ''}<b style="color:${e.delta < 0 ? 'var(--bad)' : 'var(--good)'}">${e.delta > 0 ? '+' : ''}${e.delta}</b>${e.qtd_depois !== null ? ` → saldo ${e.qtd_depois}` : ''}${e.motivo ? ' · ' + esc(e.motivo) : ''}${e.causa ? ' · causa: ' + esc(e.causa) : ''}
    ${!e.desfeito && !e.historico && e.tipo !== 'IMPORT' ? `<button class="sm subtle" data-grupo="${esc(e.grupo)}" style="margin-left:8px;min-height:24px">${ico('undo')} Desfazer</button>` : ''}${e.desfeito ? ' · <i>desfeito</i>' : ''}</div></div>`).join('')}</div></div>`;
};
const U_ok = e => parseEndereco(e).valido;
PAGINAS.mov.ligar = () => view.addEventListener('click', async e => {
  const b = e.target.closest('button[data-grupo]');
  if (!b || !confirm('Desfazer este lançamento?')) return;
  try { await api('/api/desfazer', { method: 'POST', body: { grupo: b.dataset.grupo } }); toast('Lançamento desfeito', 'ok'); rota(); }
  catch (er) { toast(er.message, 'bad', 5000); }
}, { once: true });

// ---------- configurações ----------
PAGINAS.config = async () => {
  const [cfg, users, layout, setores] = await Promise.all([api('/api/config'), S.admin ? api('/api/usuarios').catch(() => null) : null,
    S.admin ? api('/api/layout').catch(() => null) : null, S.admin ? api('/api/setores').catch(() => ({})) : null]);
  S.cfg = cfg;
  const ativos = (users || []).filter(u => u.ativo).map(u => u.nome);
  const gIds = [...new Set([...Array.from({ length: 18 }, (_, i) => i + 1), ...(layout ? layout.gondolas.map(g => g.id) : []), ...Object.keys(setores || {}).map(Number)])].sort((a, b) => a - b);
  const ladosDe2 = g => (g === 9 || g === 10 ? ['A', 'B', 'PE', 'PD'] : ['A', 'B', 'F', 'C']);
  const ROT_LADO = { A: 'Lado A', B: 'Lado B', F: 'Frente', C: 'Costas', PE: 'Pta. esq.', PD: 'Pta. dir.' };
  S.setCfg = { gIds, ativos, ladosDe: ladosDe2, rotulos: ROT_LADO, setores: JSON.parse(JSON.stringify(setores || {})), sel: ativos[0] || null };
  const cartaoResp = !S.admin || !users ? '' : `<div class="card reveal" style="--i:3;grid-column:1/-1"><div class="head"><div><h2>Setores das gôndolas</h2><div class="sub">Veja todas as gôndolas e arraste cada nome para o lado que ele cuida. Aparece no mapa e na ronda.</div></div></div>
      <div id="setGrid"></div>
      <details class="setor-nomes"><summary>Dar nome aos setores (opcional, ex.: “Higiene”)</summary><div id="setNomes"></div></details>
      <div style="margin-top:14px"><button class="primary" id="salvaSetores">${ico('check')} Salvar setores</button></div></div>`;
  return `<div class="grid cols-2" style="align-items:start">
    <div class="grid">
      <div class="card reveal"><div class="head"><div><h2>Regras de desconto</h2><div class="sub">Uma regra só para o painel, o mapa e o coletor</div></div></div>
        <div class="callout" style="margin-bottom:14px">${ico('info')}<div><b>Prevenção vigente:</b> até 90 dias, ração (seca e úmida) 20% e demais itens 30%; até 30 dias, tudo 50%. Não existe mais a faixa de 10%.</div></div>
        <div class="scroll"><table><thead><tr><th>Status</th><th>Até (dias)</th><th>Geral %</th><th>Ração %</th></tr></thead><tbody id="faixas">${cfg.faixas.map((f, i) => `<tr><td>${pill(f.status, f.cor)}</td>
          <td>${f.ate === null ? '<span class="muted">acima</span>' : `<input type="number" style="width:90px" data-i="${i}" data-k="ate" value="${f.ate}" ${S.admin ? '' : 'disabled'}>`}</td>
          <td><input type="number" min="0" max="100" style="width:90px" data-i="${i}" data-k="desconto" value="${f.desconto}" ${S.admin ? '' : 'disabled'}></td>
          <td><input type="number" min="0" max="100" style="width:90px" data-i="${i}" data-k="desconto_racao" value="${f.desconto_racao}" ${S.admin ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div>
        <label class="small" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">Avisar no recebimento quando o lote chegar com menos de <input type="number" id="valMin" min="0" max="365" style="width:90px" value="${cfg.validade_minima ?? 90}" ${S.admin ? '' : 'disabled'}> dias <span class="xs muted">(0 = não avisar)</span></label>
        ${S.admin ? `<div style="margin-top:14px"><button class="primary" id="salvaFaixas">${ico('check')} Salvar regras</button></div>` : '<p class="small muted" style="margin-top:12px">Só administradores podem alterar.</p>'}</div>
      <div class="card reveal" style="--i:1"><div class="head"><h2>Dados</h2></div>
        <div class="editbar"><a class="btn" href="/api/export.xlsx" download>${ico('download')} Exportar .xlsx</a> <a class="btn" href="/briefing" target="_blank" rel="noopener">Briefing do dia (1 página)</a> <a class="btn" href="/briefing-semanal" target="_blank" rel="noopener">Briefing semanal (1 página)</a> <a class="btn" href="/rma" target="_blank" rel="noopener">Lista de avaria e RMA</a> <a class="btn" href="#/folha">${ico('camera')} Importar folha</a></div>
        ${S.admin ? `<hr style="border:0;border-top:1px solid var(--line);margin:18px 0"><h3 style="margin-bottom:8px">Importar planilha</h3><p class="small muted" style="margin-bottom:10px">Formato do Controle_Validade (abas Produtos, FIFO, Histórico, Recebimento) ou o arquivo exportado aqui. Limite de ~4 MB; para a carga grande, use <code>npm run import</code>.</p>
        <input type="file" id="arq" accept=".xlsx"><label class="small" style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="subst" style="width:auto;min-height:0"> Substituir todo o estoque e as movimentações atuais</label>
        <button id="importar">${ico('upload')} Importar</button><pre id="impRel" class="small" style="white-space:pre-wrap;margin-top:12px"></pre>` : ''}</div>
    </div>
    ${S.admin ? `<div class="card reveal" style="--i:2"><div class="head"><div><h2>Equipe</h2><div class="sub">${S.login ? 'Cada pessoa entra com nome e PIN' : 'Login desligado neste computador — crie os acessos antes de publicar'}</div></div><button class="sm" id="novoUser">${ico('plus')} Novo</button></div>
      ${users ? users.map(u => `<div class="row" style="grid-template-columns:auto 1fr auto;${u.ativo ? '' : 'opacity:.5'}"><div class="avatar" style="width:36px;height:36px">${esc(u.nome.slice(0, 1))}</div><div><div class="pname">${esc(u.nome)}</div><div class="xs muted">${u.papel === 'admin' ? 'Administrador' : 'Operador'} · ${u.bloqueado_ate && u.bloqueado_ate > new Date().toISOString() ? '<span style="color:var(--bad)">bloqueado por tentativas erradas (crie um PIN novo para liberar)</span>' : u.tem_pin ? 'PIN definido' + (u.falhas ? ` · <span style="color:var(--warn)">${u.falhas} tentativa${u.falhas > 1 ? 's' : ''} errada${u.falhas > 1 ? 's' : ''}</span>` : '') : '<span style="color:var(--warn)">sem PIN (não consegue entrar)</span>'}${u.ativo ? '' : ' · inativo'}</div></div>
        <div class="nowrap"><button class="sm" data-pin="${esc(u.nome)}">${ico('lock')} PIN</button> <button class="sm subtle" data-ativo="${esc(u.nome)}" data-v="${u.ativo ? 0 : 1}">${u.ativo ? 'Desativar' : 'Ativar'}</button></div></div>`).join('') : '<p class="muted">Não foi possível listar.</p>'}</div>` : ''}
    ${cartaoResp}
  </div>`;
};
PAGINAS.config.ligar = () => {
  const SC = S.setCfg, sgrid = $('#setGrid');
  const nomeBonito = n => n.charAt(0) + n.slice(1).toLowerCase();
  const tem = (g, l, p) => !!(SC.setores[g] && SC.setores[g][l] && SC.setores[g][l].resp.includes(p));
  const poe = (g, l, p, v) => {
    const s = ((SC.setores[g] = SC.setores[g] || {})[l] = SC.setores[g][l] || { nome: '', resp: [] });
    s.resp = s.resp.filter(x => x !== p); if (v) s.resp.push(p);
  };
  let armado = null, arrastou = false;                 // cartão de nome "na mão" (toque) e se o último gesto foi um arrasto
  const nomesDe = (g, l) => (SC.setores[g] && SC.setores[g][l] && SC.setores[g][l].resp) || [];
  const desenhaSet = () => {
    if (!sgrid) return;
    if (!SC.ativos.length) { sgrid.innerHTML = '<p class="muted">Cadastre a equipe primeiro.</p>'; return; }
    sgrid.innerHTML = `<div class="set-pal"><div class="xs muted">Arraste um nome para o lado da gôndola. No celular: toque no nome e depois no lado. Toque no nome dentro do lado para tirar.</div>
      <div class="chips" style="margin:8px 0 0">${SC.ativos.map(n => `<button class="chip nome-card" data-p="${esc(n)}" aria-pressed="${armado === n}">${esc(nomeBonito(n))}</button>`).join('')}</div></div>
      <div class="set-gs">${SC.gIds.map(g => `<div class="set-g"><b class="set-n">${g}</b><div class="set-ls">${SC.ladosDe(g).map(l => `<div class="set-l" data-g="${g}" data-l="${l}"><span class="set-ln">${SC.rotulos[l]}</span><span class="set-tags">${nomesDe(g, l).map(n => `<button class="tag-nome" data-x="${esc(n)}" title="Tirar ${esc(nomeBonito(n))}">${esc(nomeBonito(n))}</button>`).join('')}</span></div>`).join('')}</div></div>`).join('')}</div>`;
  };
  const ligaDnd = () => {
    sgrid.addEventListener('click', e => {
      if (arrastou) { arrastou = false; return; }
      const x = e.target.closest('.tag-nome'), card = e.target.closest('.nome-card'), slot = e.target.closest('.set-l');
      if (x && slot) { poe(+slot.dataset.g, slot.dataset.l, x.dataset.x, false); desenhaSet(); return; }
      if (card) { armado = armado === card.dataset.p ? null : card.dataset.p; desenhaSet(); return; }
      if (slot && armado) { const g = +slot.dataset.g, l = slot.dataset.l; poe(g, l, armado, !nomesDe(g, l).includes(armado)); desenhaSet(); }
    });
    sgrid.addEventListener('pointerdown', e => {
      const card = e.target.closest('.nome-card'); if (!card || e.button > 0) return;
      const nome = card.dataset.p, x0 = e.clientX, y0 = e.clientY; let fant = null, alvo = null;
      const sobre = ev => { const s = document.elementFromPoint(ev.clientX, ev.clientY); return s ? s.closest('.set-l') : null; };
      const mover = ev => {
        if (!fant && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        if (!fant) { fant = document.createElement('div'); fant.className = 'nome-fantasma'; fant.textContent = nomeBonito(nome); document.body.appendChild(fant); }
        fant.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
        const s = sobre(ev); if (s !== alvo) { if (alvo) alvo.classList.remove('alvo'); alvo = s; if (alvo) alvo.classList.add('alvo'); }
      };
      const fim = ev => {
        window.removeEventListener('pointermove', mover); window.removeEventListener('pointerup', fim); window.removeEventListener('pointercancel', fim);
        if (!fant) return;                                   // foi só um toque: o clique arma o nome
        const s = sobre(ev); fant.remove(); if (alvo) alvo.classList.remove('alvo');
        arrastou = true; setTimeout(() => { arrastou = false; }, 0);
        if (s) { poe(+s.dataset.g, s.dataset.l, nome, true); desenhaSet(); }
      };
      window.addEventListener('pointermove', mover); window.addEventListener('pointerup', fim); window.addEventListener('pointercancel', fim);
    });
  };
  if (sgrid) {
    desenhaSet(); ligaDnd();
    $('#setNomes').innerHTML = `<div class="rg">${SC.gIds.map(g => `<div class="rg-row nm"><b class="rg-n">${g}</b>${SC.ladosDe(g).map(l => `<input type="text" maxlength="40" data-g="${g}" data-l="${l}" placeholder="${SC.rotulos[l]}" value="${esc((SC.setores[g] && SC.setores[g][l] && SC.setores[g][l].nome) || '')}" aria-label="Nome do setor, gôndola ${g}, ${SC.rotulos[l]}">`).join('')}</div>`).join('')}</div>`;
    $('#setNomes').addEventListener('input', e => {
      const i = e.target.closest('input[data-l]'); if (!i) return;
      const s = ((SC.setores[i.dataset.g] = SC.setores[i.dataset.g] || {})[i.dataset.l] = SC.setores[i.dataset.g][i.dataset.l] || { nome: '', resp: [] });
      s.nome = i.value.trim();
    });
  }
  const ss = $('#salvaSetores');
  if (ss) ss.addEventListener('click', async () => {
    const r = {};
    for (const g of Object.keys(SC.setores)) for (const l of Object.keys(SC.setores[g])) {
      const s = SC.setores[g][l]; if (s.nome || s.resp.length) (r[g] = r[g] || {})[l] = { nome: s.nome, resp: s.resp };
    }
    try { await api('/api/setores', { method: 'PUT', body: r }); toast('Setores salvos', 'ok'); } catch (e) { toast(e.message, 'bad', 5000); }
  });
  const sf = $('#salvaFaixas');
  if (sf) sf.addEventListener('click', async () => {
    const faixas = S.cfg.faixas.map(f => ({ ...f }));
    $$('#faixas input').forEach(i => { faixas[+i.dataset.i][i.dataset.k] = Number(i.value); });
    try { await api('/api/config', { method: 'PUT', body: { faixas, validade_minima: Number($('#valMin').value) } }); toast('Regras salvas', 'ok'); S.resumo = null; rota(); } catch (e) { toast(e.message, 'bad', 5000); }
  });
  const imp = $('#importar');
  if (imp) imp.addEventListener('click', async () => {
    const f = $('#arq').files[0];
    if (!f) return toast('Escolha um arquivo .xlsx', 'bad');
    const subst = $('#subst').checked;
    if (subst && !confirm('Isso apaga o estoque e as movimentações atuais. Continuar?')) return;
    $('#impRel').textContent = 'Importando…';
    try {
      const r = await api('/api/import' + (subst ? '?substituir=1' : ''), { method: 'POST', body: await f.arrayBuffer() });
      $('#impRel').textContent = `Produtos: ${r.produtos}\nLotes: ${r.lotes} (${r.lotes_agrupados} agrupados)\nBaixas históricas: ${r.baixas_historico}\nRecebimentos históricos: ${r.recebimentos_historico}` + (r.avisos.length ? '\n\nAvisos:\n- ' + r.avisos.slice(0, 15).join('\n- ') : '');
      S.resumo = null; carregaResumo();
    } catch (e) { $('#impRel').textContent = ''; toast(e.message, 'bad', 6000); }
  });
  const nu = $('#novoUser');
  if (nu) nu.addEventListener('click', async () => {
    const d = await dialogo({ titulo: 'Novo usuário', sub: 'O PIN tem de 6 a 8 números.', campos: [{ id: 'nome', label: 'Nome' }, { id: 'pin', label: 'PIN (aparece na tela para você conferir)', tipo: 'text', inputmode: 'numeric' }, { id: 'papel', label: 'Papel', tipo: 'select', opcoes: ['operador', 'admin'] }], ok: 'Criar' });
    if (d) try { await api('/api/usuarios', { method: 'POST', body: d }); toast('Usuário criado', 'ok'); rota(); } catch (e) { toast(e.message, 'bad', 5000); }
  });
  $$('[data-pin]').forEach(b => b.addEventListener('click', async () => {
    const d = await dialogo({ titulo: 'Novo PIN', sub: b.dataset.pin, campos: [{ id: 'pin', label: 'PIN (6 a 8 números — aparece na tela para você conferir)', tipo: 'text', inputmode: 'numeric' }], ok: 'Salvar' });
    if (d) try { await api('/api/usuarios/' + encodeURIComponent(b.dataset.pin), { method: 'PUT', body: { pin: d.pin } }); toast('PIN atualizado', 'ok'); rota(); } catch (e) { toast(e.message, 'bad', 5000); }
  }));
  $$('[data-ativo]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/usuarios/' + encodeURIComponent(b.dataset.ativo), { method: 'PUT', body: { ativo: b.dataset.v === '1' } }); rota(); } catch (e) { toast(e.message, 'bad', 5000); }
  }));
};

// ---------- início ----------
(async () => {
  for (const [id, ic] of [['logo', 'box'], ['i-geral', 'grid'], ['i-mapa', 'map'], ['i-estoque', 'layers'], ['i-mov', 'clock'], ['i-config', 'sliders'], ['i-coletor', 'scan'], ['i-mais', 'more'], ['i-conferencias', 'clipboard'], ['m-conferencias', 'clipboard'],
    ['i-tv', 'tv'], ['m-tv', 'tv'], ['m-mov', 'clock'], ['m-config', 'sliders'], ['m-export', 'download'], ['m-sair', 'logout']]) $('#' + id).innerHTML = ico(ic, 22);
  $('#atualiza').innerHTML = ico('refresh');
  $('#export').innerHTML = ico('download') + ' Exportar';
  $('#voltar').innerHTML = ico('chevron');
  $('#voltar').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/geral'; });
  $('#maisBtn').addEventListener('click', alternaMais);
  $('#maisBack').addEventListener('click', fechaMais);
  $$('.sheet-item').forEach(a => a.addEventListener('click', fechaMais));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fechaMais(); });
  try {
    let eu;
    try { eu = await api('/api/eu'); lsSet('eu', eu); }
    catch (e) {
      if (!e.rede || !lsGet('eu', null)) throw e;
      eu = lsGet('eu'); S.offlineInicio = true;                     // sem rede: abre com a identificação guardada; o coletor e as conferências funcionam
      toast('Sem conexão: modo offline. O que você registrar sobe quando a internet voltar.', '', 6000);
    }
    S.login = eu.login; S.usuario = eu.usuario; S.admin = !eu.login || eu.usuario?.papel === 'admin';
    S.op = eu.usuario ? eu.usuario.nome : (lsGet('operador', eu.operadores[0] || 'LOCAL'));
    S.ops = eu.operadores;
  } catch (e) { toast(e.rede ? 'Sem conexão com o servidor. Verifique a internet e recarregue.' : 'Não consegui falar com o servidor: ' + e.message, 'bad', 8000); return; }
  $('#meNome').textContent = S.op; $('#avatar').textContent = S.op.slice(0, 1);
  $('#mePapel').textContent = S.login ? (S.admin ? 'Administrador' : 'Operador') : 'Modo local';
  if (S.login) {
    const sair = async () => { await api('/api/logout', { method: 'POST', body: {}, semRedirect: true }); location.href = '/login'; };
    const s = $('#sair'); s.hidden = false; s.innerHTML = ico('logout'); s.addEventListener('click', sair);
    const ms = $('#maisSair'); ms.hidden = false; ms.addEventListener('click', sair);
  }
  $('#atualiza').addEventListener('click', () => { S.resumo = null; rota(); });
  Fila.inicia();
  api('/api/config').then(x => { lsSet('config', x); setAreas(x.areas); }).catch(() => { const x = lsGet('config', null); if (x) setAreas(x.areas); });
  carregaResumo().catch(() => {});
  if (!location.hash && S.login && !S.admin) location.hash = '#/coletor';   // operador da loja entra direto no coletor
  rota();
})();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => { if (!document.hidden && (location.hash === '' || location.hash === '#/geral') && !$('#dlg').open) { S.resumo = null; rota(); } }, 120000);
