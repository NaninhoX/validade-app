// Estoque por produto: cada produto (EAN) é uma linha que abre e mostra os lotes.
// Hierarquia de ações: o preço se edita na própria linha (é do produto); no lote, "Dar baixa" é a decisão principal
// (vira "Retirar" quando venceu) e ajustar/mover ficam como ícones; cadastro e histórico ficam no menu "⋯" do produto.
const EstGrp = (() => {
  const G = { grupos: [], offset: 0, total: 0, totalLotes: 0, abertos: new Set(), ordem: '', dir: 'asc' };
  const ANTIGO = 60;                                        // dias; igual a PRECO_ANTIGO_DIAS no servidor

  const velho = g => g.preco !== null && (g.preco_dias === null || g.preco_dias > ANTIGO);
  const idade = g => (g.preco === null ? '' : g.preco_dias === null ? '<span class="ped velho">sem data</span>'
    : `<span class="ped${g.preco_dias > ANTIGO ? ' velho' : ''}">${g.preco_dias === 0 ? 'hoje' : 'há ' + g.preco_dias + ' d'}</span>`);
  const precoCel = g => (g.preco === null ? '<button class="sm" data-g="preco">＋ Preço</button>'
    : `<button class="preco-b" data-g="preco" title="Clique para editar o preço" aria-label="Editar preço, hoje ${esc(brl(g.preco))}">${brl(g.preco)}</button>`);
  const confirma = g => (velho(g) ? `<button class="icon subtle sm" data-g="conf" title="Confirmar que o preço está correto" aria-label="Confirmar preço">${ico('check')}</button>` : '');

  const linhaL = l => `<div class="eg-l">
    <span class="eg-ls">${pill(l.status, l.cor)}</span>
    <span class="eg-lt" data-l="Lote">${esc(l.lote)}</span>
    <span class="num" data-l="Qtd">${l.qtd}</span>
    <span class="nowrap" data-l="Validade">${brData(l.validade_efetiva || l.validade)}</span>
    <span class="num" data-l="Dias">${l.dias}</span>
    <span class="eg-le">${addr(l.endereco, l.endereco_ok)}</span>
    <span class="num eg-lo">${l.desconto ? `<b>${l.desconto}%</b>${l.preco_desc !== null ? ` <span class="xs muted">${brl(l.preco_desc)}</span>` : ''}` : '<span class="faint">—</span>'}</span>
    <span class="eg-lac">${l.dias <= 0
    ? `<button class="sm danger" data-act="baixa" data-id="${l.id}">${ico('minus')} Retirar</button>`
    : `<button class="sm" data-act="baixa" data-id="${l.id}">${ico('minus')} Dar baixa</button>`}<button class="icon subtle sm" data-act="ajuste" data-id="${l.id}" title="Ajustar quantidade" aria-label="Ajustar quantidade">${ico('edit')}</button><button class="icon subtle sm" data-act="mover" data-id="${l.id}" title="Mover de endereço" aria-label="Mover de endereço">${ico('move')}</button></span></div>`;

  const linhaG = g => `<details class="eg-g" data-ean="${esc(g.ean)}"${G.abertos.has(g.ean) ? ' open' : ''}>
    <summary class="eg-r">
      <span class="eg-chev">${ico('chevron')}</span>
      <span class="eg-p"><span class="pname" title="${esc(g.nome || '')}">${esc(g.nome || '(sem cadastro)')}</span><span class="xs muted">${esc(g.ean)}${g.marca ? ' · ' + esc(g.marca) : ''} · ${g.lotes.length} lote${g.lotes.length > 1 ? 's' : ''}</span></span>
      <span class="eg-st">${pill(g.status, g.cor)}</span>
      <span class="num eg-q">${int(g.qtd)}</span>
      <span class="nowrap c-venc">${brData(g.validade_min)}</span>
      <span class="num c-dias">${g.dias_min}</span>
      <span class="num eg-preco">${precoCel(g)}</span>
      <span class="eg-at">${g.nome ? idade(g) + confirma(g) : '<button class="sm" data-g="cad">Cadastrar…</button>'}</span>
      <span class="num c-valor">${g.valor === null ? '—' : brl(g.valor)}</span>
      <span class="eg-ac"><button class="icon subtle sm" data-g="menu" title="Mais ações do produto" aria-label="Mais ações do produto">${ico('more')}</button></span>
    </summary>
    <div class="eg-lotes"><div class="eg-lh"><span>Status</span><span>Lote</span><span class="num">Qtd</span><span>Validade</span><span class="num">Dias</span><span>Endereço</span><span class="num">Oferta</span><span></span></div>${g.lotes.map(linhaL).join('')}</div></details>`;

  const achaEl = g => $(`details[data-ean="${CSS.escape(g.ean)}"]`);
  const renderUm = g => { const el = achaEl(g); if (el) el.outerHTML = linhaG(g); };

  async function carrega(reset, limite = 50) {
    if (reset) { G.offset = 0; G.grupos = []; $('#egBody').innerHTML = ''; }
    const p = new URLSearchParams({ agrupar: 1, offset: G.offset, limite });
    if (G.ordem) { p.set('ordem', G.ordem); p.set('dir', G.dir); }
    for (const k of ['q', 'status', 'gondola', 'marca', 'sempreco']) if (E[k]) p.set(k, E[k]);
    const r = await api('/api/lotes?' + p);
    G.total = r.total; G.totalLotes = r.total_lotes;
    if (reset && E.q && r.total <= 2) r.itens.forEach(g => G.abertos.add(g.ean));        // busca bem específica: já abre os lotes
    G.grupos.push(...r.itens);
    $('#egBody').insertAdjacentHTML('beforeend', r.itens.map(linhaG).join('') || (reset ? '<div class="muted" style="padding:32px;text-align:center">Nenhum produto com esses filtros.</div>' : ''));
    G.offset += r.itens.length;
    $('#estInfoG').textContent = `${int(Math.min(G.offset, G.total))} de ${int(G.total)} produtos · ${int(G.totalLotes)} lotes`;
    $('#maisG').hidden = G.offset >= G.total;
    window.__lotes = Object.assign(window.__lotes || {}, Object.fromEntries(r.itens.flatMap(g => g.lotes.map(l => [l.id, l]))));
  }
  const recarrega = () => carrega(true, Math.max(50, G.offset));

  // ---------- preço na própria linha ----------
  function aplicaPreco(g, v) {
    g.preco = v; g.preco_dias = 0; g.preco_em = new Date().toISOString(); g.valor = 0;
    for (const l of g.lotes) { l.preco = v; l.valor = +(v * l.qtd).toFixed(2); l.preco_desc = l.desconto ? +(v * (1 - l.desconto / 100)).toFixed(2) : null; g.valor += l.valor; }
    g.valor = +g.valor.toFixed(2);
  }
  async function salvaPreco(g, v) {
    try {
      await api('/api/produtos', { method: 'POST', body: { ean: g.ean, nome: g.nome || g.ean, preco: v, confirmar: true } });
      aplicaPreco(g, v); renderUm(g); toast(`Preço salvo: ${(g.nome || g.ean).slice(0, 38)} · ${brl(v)}`, 'ok', 3000); carregaResumo();
    } catch (e) { toast(e.message, 'bad', 5000); renderUm(g); }
  }
  function editaPreco(g, cel) {
    cel.innerHTML = `<input class="preco-in" inputmode="decimal" value="${g.preco === null ? '' : String(g.preco).replace('.', ',')}" aria-label="Preço de ${esc(g.nome || g.ean)}">`;
    const inp = $('input', cel); inp.focus(); inp.select();
    let feito = false;
    const sai = (modo) => {                                 // Enter confirma (mesmo igual); sair do campo só salva se mudou; Esc cancela
      if (feito) return; feito = true;
      const v = parsePreco(inp.value), ok = v !== null && !Number.isNaN(v);
      if (modo === 'esc' || (modo === 'blur' && (!ok || v === g.preco))) return renderUm(g);
      if (!ok) { feito = false; toast('Preço inválido. Ex.: 39,90 ou 1.299,90', 'bad', 3500); return inp.focus(); }
      salvaPreco(g, v);
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); sai('enter'); } else if (e.key === 'Escape') { e.preventDefault(); sai('esc'); } });
    inp.addEventListener('keyup', e => e.stopPropagation());
    inp.addEventListener('blur', () => sai('blur'));
  }

  // ---------- menu do produto ----------
  function menuFlutuante(ancora, html, aoClicar) {
    $$('.menu.flutua').forEach(m => m.remove());
    const m = document.createElement('div'); m.className = 'menu flutua'; m.innerHTML = html; document.body.appendChild(m);
    const r = ancora.getBoundingClientRect();
    m.style.position = 'fixed'; m.style.right = 'auto';
    m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)) + 'px';
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
    const fecha = () => { m.remove(); document.removeEventListener('mousedown', fora, true); document.removeEventListener('keydown', tecla, true); window.removeEventListener('scroll', fecha, true); };
    const fora = ev => { if (!m.contains(ev.target)) fecha(); };
    const tecla = ev => { if (ev.key === 'Escape') fecha(); };
    document.addEventListener('mousedown', fora, true); document.addEventListener('keydown', tecla, true); window.addEventListener('scroll', fecha, true);
    m.addEventListener('click', ev => { const it = ev.target.closest('[data-m]'); if (it) { fecha(); if (aoClicar) aoClicar(it.dataset.m); } });
    return m;
  }
  function menuProduto(g, btn) {
    menuFlutuante(btn, `${g.nome ? '' : `<button class="menu-item" data-m="cadastra">${ico('plus')} Cadastrar ou vincular…</button>`}<button class="menu-item" data-m="cad">${ico('edit')} Editar nome e marca</button><button class="menu-item" data-m="hist">${ico('clock')} Histórico de preços</button>`, async acao => {
      if (acao === 'cadastra') return cadastra(g);
      if (acao === 'cad') {
        const d = await dialogo({ titulo: 'Cadastro do produto', sub: g.ean, campos: [{ id: 'nome', label: 'Nome', valor: g.nome || '' }, { id: 'marca', label: 'Marca', valor: g.marca || '' }], ok: 'Salvar' });
        if (!d) return;
        if (!d.nome.trim()) return toast('Informe o nome do produto', 'bad');
        try { await api('/api/produtos', { method: 'POST', body: { ean: g.ean, nome: d.nome.trim(), marca: d.marca.trim() || undefined } }); g.nome = d.nome.trim(); if (d.marca.trim()) g.marca = d.marca.trim(); renderUm(g); toast('Cadastro salvo', 'ok'); }
        catch (e) { toast(e.message, 'bad', 5000); }
      } else {
        let h = [];
        try { h = await api(`/api/produtos/${encodeURIComponent(g.ean)}/precos`); } catch (e) { return toast(e.message, 'bad', 5000); }
        const conf = g.preco_em ? `Conferido em ${brDataHora(g.preco_em)}${g.preco_por ? ' por ' + esc(g.preco_por) : ''}` : 'Preço nunca conferido no app';
        menuFlutuante(btn, `<div class="menu-sec">Histórico de preços</div><div class="xs muted" style="padding:0 10px 6px">${conf}</div>${h.length
          ? h.map(x => `<div class="eg-hist"><span>${brDataHora(x.em)}</span><b>${brl(x.preco_antes)} → ${brl(x.preco_depois)}</b><span class="muted">${esc(x.por || '')}</span></div>`).join('')
          : '<div class="xs muted" style="padding:6px 10px">Nenhuma mudança registrada ainda.</div>'}`);
      }
    });
  }

  // produto no estoque sem cadastro: cadastrar na hora, ou ligar a outro produto (mesmo item com outro código, ou código lido errado)
  async function cadastra(g) {
    const r = await CadProduto.abre({ ean: g.ean, aviso: 'está no estoque sem cadastro' });
    if (!r) return;
    try {
      if (r.tipo === 'novo') { await api('/api/produtos', { method: 'POST', body: { ean: g.ean, nome: r.nome, marca: r.marca, preco: r.preco, confirmar: r.preco !== undefined } }); toast('Produto cadastrado', 'ok', 2500); }
      else { await api('/api/produtos/vincular', { method: 'POST', body: { de: g.ean, para: r.para, alias: r.tipo === 'mesmo' } }); toast('Lotes passados para ' + (r.nome || '').slice(0, 40), 'ok', 3500); }
      carregaResumo(); recarrega();
    } catch (e) { toast(e.message, 'bad', 5000); }
  }

  // ---------- ligação ----------
  function liga() {
    const corpo = $('#egBody'), cab = $('#egHead');
    corpo.addEventListener('click', e => {
      const sum = e.target.closest('summary');
      if (sum && e.target.closest('button, input')) e.preventDefault();      // botões e campos dentro da linha não abrem nem fecham
      if (e.target.closest('button[data-act]')) return acaoLote(e);
      const b = e.target.closest('button[data-g]');
      if (!b) return;
      const g = G.grupos.find(x => x.ean === b.closest('details').dataset.ean);
      if (!g) return;
      if (!g.nome && (b.dataset.g === 'preco' || b.dataset.g === 'cad')) return cadastra(g);
      if (b.dataset.g === 'preco') editaPreco(g, b.closest('.eg-preco'));
      else if (b.dataset.g === 'conf') salvaPreco(g, g.preco);
      else if (b.dataset.g === 'menu') menuProduto(g, b);
    });
    corpo.addEventListener('toggle', ev => { const d = ev.target; if (d.tagName === 'DETAILS') { if (d.open) G.abertos.add(d.dataset.ean); else G.abertos.delete(d.dataset.ean); } }, true);
    $('#maisG').addEventListener('click', () => carrega(false));
    $('#egAbre').addEventListener('click', () => $$('#egBody details').forEach(d => { d.open = true; }));
    $('#egFecha').addEventListener('click', () => $$('#egBody details').forEach(d => { d.open = false; }));
    const marca = () => $$('[data-o]', cab).forEach(t => { if (t.dataset.o === G.ordem) t.setAttribute('aria-sort', G.dir === 'desc' ? 'descending' : 'ascending'); else t.removeAttribute('aria-sort'); });
    const ordena = t => { const o = t.dataset.o; if (G.ordem !== o) { G.ordem = o; G.dir = 'asc'; } else if (G.dir === 'asc') G.dir = 'desc'; else { G.ordem = ''; G.dir = 'asc'; } marca(); carrega(true); };
    cab.addEventListener('click', e => { const t = e.target.closest('[data-o]'); if (t) ordena(t); });
    cab.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const t = e.target.closest('[data-o]'); if (t) { e.preventDefault(); ordena(t); } });
    marca();
  }

  return { carrega, recarrega, liga };
})();
