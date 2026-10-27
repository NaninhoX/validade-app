// Produto não cadastrado: achar o parecido (mesmos últimos 6 dígitos do código, ou parte do nome) ou cadastrar na hora.
// Serve para conferências, estoque e qualquer tela que encontre um código sem produto.
//   abre({ ean })      -> null | { tipo: 'novo', nome, marca, preco } | { tipo: 'mesmo', para, nome } | { tipo: 'erro', para, nome }
//   'mesmo' = é o mesmo produto com outro código de barras (guarda o código); 'erro' = o código foi lido ou digitado errado (só corrige).
//   escolher(lista)    -> o item escolhido ou null (para quando o final digitado bate com mais de um produto)
const CadProduto = (() => {
  async function procura(q, exceto) {
    if (navigator.onLine) {
      try { return await api('/api/produtos/candidatos?q=' + encodeURIComponent(q) + (exceto ? '&exceto=' + encodeURIComponent(exceto) : ''), { tentativas: 0 }); } catch { /* usa o catálogo do aparelho */ }
    }
    return Catalogo.porFinal(q);
  }
  const linhaCand = (c, i, acoes) => `<div class="cad-c"><div class="cad-n"><b>${esc(c.nome || c.ean)}</b><div class="xs muted">${esc(c.ean)}${c.marca ? ' · ' + esc(c.marca) : ''}${c.lotes ? ' · ' + c.lotes + (c.lotes > 1 ? ' lotes' : ' lote') + ' em estoque' : ''}</div></div><div class="cad-cb">${acoes(i)}</div></div>`;

  function abre({ ean, aviso }) {
    return new Promise(resolve => {
      $$('#dlgCad').forEach(d => d.remove());
      const dlg = document.createElement('dialog');
      dlg.id = 'dlgCad'; dlg.className = 'cad';
      dlg.innerHTML = `<form method="dialog" id="cadForm">
        <h2>Produto não cadastrado</h2>
        <p class="muted small" style="margin:4px 0 14px">Código ${esc(ean)}${aviso ? ' · ' + esc(aviso) : ''}</p>
        <div class="cad-sec"><b>Parece algum destes?</b>
          <div class="xs muted" style="margin:2px 0 8px">Mesmos últimos 6 dígitos do código. Dá para digitar outro final ou parte do nome.</div>
          <input id="cadBusca" type="search" placeholder="últimos 6 dígitos ou nome" autocomplete="off" value="${esc(String(ean).slice(-6))}" aria-label="Buscar produto parecido">
          <div class="cad-lista" id="cadLista"><div class="xs muted">Procurando…</div></div></div>
        <div class="cad-sec"><b>Ou cadastrar como produto novo</b>
          <div style="margin-top:8px"><label class="f" for="cadNome">Nome do produto</label><input id="cadNome" autocomplete="off"></div>
          <div class="cad-2"><div><label class="f" for="cadMarca">Marca (opcional)</label><input id="cadMarca" autocomplete="off"></div>
            <div><label class="f" for="cadPreco">Preço (opcional)</label><input id="cadPreco" inputmode="decimal" autocomplete="off" placeholder="39,90"></div></div></div>
        <menu><button type="button" id="cadNao">Agora não</button><button type="button" class="primary" id="cadNovo">Cadastrar como novo</button></menu></form>`;
      document.body.appendChild(dlg);
      let lista = [], feito = false;
      const fim = v => { if (feito) return; feito = true; try { dlg.close(); } catch { /* já fechado */ } dlg.remove(); resolve(v); };
      const desenhaLista = () => {
        $('#cadLista', dlg).innerHTML = lista.length
          ? lista.map((c, i) => linhaCand(c, i, k => `<button type="button" class="sm" data-t="mesmo" data-i="${k}" title="É o mesmo produto, só com outro código de barras: o código passa a valer para ele">Mesmo produto</button><button type="button" class="sm subtle" data-t="erro" data-i="${k}" title="O código foi lido ou digitado errado: corrige só esta vez">Leitura errada</button>`)).join('')
          : '<div class="xs muted">Nenhum produto parecido. Cadastre como novo abaixo.</div>';
      };
      let deb = 0, seq = 0;
      const busca = async () => {
        const q = $('#cadBusca', dlg).value.trim(), n = ++seq;
        const r = q.length >= 3 ? await procura(q, ean) : [];
        if (n !== seq || feito) return;
        lista = r || []; desenhaLista();
        if (!lista.length && !$('#cadNome', dlg).value) $('#cadNome', dlg).focus();
      };
      $('#cadBusca', dlg).addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(busca, 250); });
      $('#cadLista', dlg).addEventListener('click', e => {
        const b = e.target.closest('[data-t]'); if (!b) return;
        const c = lista[+b.dataset.i]; if (c) fim({ tipo: b.dataset.t, para: c.ean, nome: c.nome });
      });
      const novo = () => {
        const nome = $('#cadNome', dlg).value.trim();
        if (!nome) { toast('Informe o nome do produto', 'bad', 2500); return $('#cadNome', dlg).focus(); }
        const bruto = $('#cadPreco', dlg).value.trim(), preco = bruto ? parsePreco(bruto) : undefined;
        if (bruto && (preco === null || Number.isNaN(preco))) { toast('Preço inválido. Ex.: 39,90', 'bad', 3000); return $('#cadPreco', dlg).focus(); }
        fim({ tipo: 'novo', nome, marca: $('#cadMarca', dlg).value.trim() || undefined, preco });
      };
      $('#cadNovo', dlg).addEventListener('click', novo);
      $('#cadNao', dlg).addEventListener('click', () => fim(null));
      dlg.addEventListener('cancel', e => { e.preventDefault(); fim(null); });
      dlg.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('#cadNome, #cadMarca, #cadPreco')) { e.preventDefault(); novo(); } });
      dlg.showModal();
      busca();
    });
  }

  function escolher(itens, { titulo = 'Qual é o produto?', sub = '' } = {}) {
    return new Promise(resolve => {
      $$('#dlgCad').forEach(d => d.remove());
      const dlg = document.createElement('dialog');
      dlg.id = 'dlgCad'; dlg.className = 'cad';
      dlg.innerHTML = `<form method="dialog"><h2>${esc(titulo)}</h2>${sub ? `<p class="muted small" style="margin:4px 0 12px">${esc(sub)}</p>` : ''}
        <div class="cad-lista" id="cadLista">${itens.map((c, i) => linhaCand(c, i, k => `<button type="button" class="sm primary" data-i="${k}">É este</button>`)).join('')}</div>
        <menu><button type="button" id="cadNao">Cancelar</button></menu></form>`;
      document.body.appendChild(dlg);
      let feito = false;
      const fim = v => { if (feito) return; feito = true; try { dlg.close(); } catch { /* já fechado */ } dlg.remove(); resolve(v); };
      $('#cadLista', dlg).addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) fim(itens[+b.dataset.i]); });
      $('#cadNao', dlg).addEventListener('click', () => fim(null));
      dlg.addEventListener('cancel', e => { e.preventDefault(); fim(null); });
      dlg.showModal();
    });
  }

  return { abre, escolher, procura };
})();
