'use strict';
// Importar folha: foto da folha FIFO manuscrita -> linhas propostas -> a pessoa confere só as duvidosas -> lança.
// A leitura nunca grava sozinha: só /api/folha/lancar grava, com as linhas que a pessoa confirmou.
const Folha = (() => {
  let st;   // { fase, linhas, endereco, erro, envio }
  const reset = () => { st = { fase: 'foto', linhas: [], endereco: '', erro: '', envio: uuid(), resultado: null }; };
  reset();

  const raiz = () => $('#folhaRaiz');

  function html() {
    return '<div class="folha" id="folhaRaiz"></div>';
  }

  function ligar() {
    reset();
    desenha();
    raiz().addEventListener('click', onClick);
    raiz().addEventListener('change', onChange);
    raiz().addEventListener('input', onInput);
  }

  // ---------- foto ----------
  // Reduz para no máximo 1600 px no lado maior e JPEG ~0,8 (celular manda 4000 px; o servidor aceita até 4 MB).
  async function reduzir(arquivo) {
    const url = URL.createObjectURL(arquivo);
    try {
      const img = await new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => err(new Error('Não consegui abrir essa imagem. Tente outra foto.')); i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.8);
    } finally { URL.revokeObjectURL(url); }
  }

  async function aoEscolherFoto(arquivo) {
    st.erro = ''; st.fase = 'lendo'; desenha();
    try {
      const foto = await reduzir(arquivo);
      const r = await api('/api/folha/ler', { method: 'POST', body: { foto, operador: S.op }, tentativas: 0 });
      st.linhas = r.linhas.map(l => ({
        ...l, validade: l.validade ? brData(l.validade) : l.original.validade, nome: '', incluir: l.bloqueios.length === 0, descartada: false, erroLancar: '',
        precisaCorrigir: l.bloqueios.length > 0,
      }));
      st.fase = 'conferir';
    } catch (e) { st.erro = e.message; st.fase = 'foto'; }
    desenha();
  }

  // ---------- telas ----------
  function desenha() {
    const el = raiz(); if (!el) return;
    el.innerHTML = st.fase === 'foto' ? telaFoto() : st.fase === 'lendo' ? telaLendo() : st.fase === 'fim' ? telaFim() : telaConferir();
  }

  function telaFoto() {
    return `<div class="card">
      <div class="head"><div><h2>Importar folha de papel</h2><div class="sub">Tire uma foto da folha de controle (FIFO) e confira o que foi lido antes de lançar</div></div></div>
      ${st.erro ? `<div class="callout warn" style="margin-bottom:14px">${ico('alert')}<div>${esc(st.erro)}</div></div>` : ''}
      <ol class="small folha-dicas"><li>Folha inteira na foto, de frente e bem iluminada.</li><li>Nada é lançado sozinho: você confere as linhas duvidosas.</li></ol>
      <div class="field"><label class="f" for="folhaEnd">Endereço para todos os lotes (opcional)</label>
        <input id="folhaEnd" autocomplete="off" autocapitalize="characters" placeholder="ex.: 1-B-3 (vazio = sem endereço)" value="${esc(st.endereco)}"></div>
      <label class="btn primary folha-foto" for="folhaArq">${ico('camera')} Tirar foto ou escolher da galeria</label>
      <input type="file" id="folhaArq" accept="image/*" hidden>
    </div>`;
  }

  const telaLendo = () => `<div class="card folha-lendo" role="status"><div class="skeleton" style="height:12px;width:60%"></div><div class="skeleton" style="height:12px;width:90%;margin-top:10px"></div><div class="skeleton" style="height:12px;width:75%;margin-top:10px"></div><p class="muted" style="margin-top:16px">Lendo a foto… pode levar até meio minuto.</p></div>`;

  function campo(i, k, rot, extra = '') {
    const l = st.linhas[i];
    return `<div class="field"><label class="f" for="f${i}${k}">${rot}</label><input id="f${i}${k}" data-i="${i}" data-k="${k}" value="${esc(l[k])}" autocomplete="off" ${extra}></div>`;
  }

  function cartaoDuvida(l, i) {
    const naoCad = l.motivos.some(m => /não cadastrado/.test(m));
    return `<div class="card folha-linha ${l.incluir ? '' : 'off'}">
      <div class="head"><div><b>Linha ${l.n}</b> <span class="xs muted">${l.original.ean ? 'lido: ' + esc(l.original.ean) : ''}</span></div>
        <button class="sm subtle" data-descartar="${i}">${ico('x')} Descartar</button></div>
      <ul class="folha-motivos small">${l.motivos.map(m => `<li>${esc(m)}</li>`).join('')}${l.erroLancar ? `<li class="erro">${esc(l.erroLancar)}</li>` : ''}</ul>
      ${l.sugestoes.length ? `<div class="xs muted">Será que é um destes?</div><div class="chips">${l.sugestoes.map(s => `<button class="chip" data-sug="${i}" data-ean="${esc(s.ean)}">${esc(s.ean)}<span class="xs" style="font-weight:400"> ${esc(s.nome).slice(0, 28)}</span></button>`).join('')}</div>` : ''}
      <div class="folha-campos">
        ${campo(i, 'ean', 'EAN', 'inputmode="numeric"')}
        ${campo(i, 'lote', 'Lote', 'autocapitalize="characters"')}
        ${campo(i, 'validade', 'Validade (dd/mm/aa)', 'inputmode="numeric"')}
        ${campo(i, 'qtd', 'Quantidade', 'inputmode="numeric"')}
      </div>
      ${naoCad ? campo(i, 'nome', 'Nome do produto novo (cadastra ao lançar)') : ''}
      <label class="folha-ok"><input type="checkbox" data-incluir="${i}" ${l.incluir ? 'checked' : ''}> Lançar esta linha${l.precisaCorrigir && !l.incluir ? ' (corrija os campos para liberar)' : ''}</label>
    </div>`;
  }

  function telaConferir() {
    const oks = st.linhas.filter(l => l.status === 'ok' && !l.descartada);
    const duv = st.linhas.map((l, i) => [l, i]).filter(([l]) => l.status !== 'ok' && !l.descartada);
    const n = st.linhas.filter(l => !l.descartada && l.incluir).length;
    return `<div class="folha-resumo card"><div class="head"><div><h2>Conferir a leitura</h2><div class="sub">${duv.length ? `${duv.length} linha(s) para conferir` : 'Nenhuma linha duvidosa'} · ${oks.length} ok</div></div>
        <button class="sm subtle" id="folhaOutra">${ico('camera')} Outra foto</button></div>
      <div class="callout">${ico('info')}<div>A foto foi lida por computador e pode errar números como 1 e 7. Corrija o que estiver diferente do papel.</div></div></div>
    ${duv.map(([l, i]) => cartaoDuvida(l, i)).join('')}
    ${oks.length ? `<details class="card folha-oks"><summary>${oks.length} linha${oks.length > 1 ? 's' : ''} ok</summary>
      <div class="scroll"><table class="small"><thead><tr><th>EAN</th><th>Produto</th><th>Lote</th><th>Validade</th><th>Qtd</th></tr></thead><tbody>${oks.map(l => `<tr><td>${esc(l.ean)}</td><td>${esc(l.produto || '')}</td><td>${esc(l.lote)}</td><td>${esc(l.validade)}</td><td>${esc(l.qtd)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    <div class="folha-barra"><button class="primary" id="folhaLancar" ${n ? '' : 'disabled'}>${ico('check')} Lançar ${n} lote${n === 1 ? '' : 's'}</button></div>`;
  }

  function telaFim() {
    const r = st.resultado;
    return `<div class="card"><div class="head"><div><h2>${r.lancadas} lote${r.lancadas === 1 ? '' : 's'} lançado${r.lancadas === 1 ? '' : 's'}</h2><div class="sub">${st.endereco ? 'Endereço ' + esc(st.endereco) : 'Sem endereço: confira depois em Estoque, qualidade dos dados'}</div></div></div>
      ${r.avisos.length ? `<div class="callout warn" style="margin-bottom:14px">${ico('alert')}<div><b>Avisos</b><ul class="small" style="margin:6px 0 0 16px">${r.avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="editbar"><button class="primary" id="folhaNova">${ico('camera')} Importar outra folha</button> <a class="btn" href="#/estoque">Ver estoque</a></div></div>`;
  }

  // ---------- eventos ----------
  async function lancar() {
    const linhas = st.linhas.filter(l => !l.descartada && l.incluir);
    const btn = $('#folhaLancar'); if (btn) btn.disabled = true;
    try {
      const r = await api('/api/folha/lancar', { method: 'POST', tentativas: 0, body: {
        envio: st.envio, endereco: st.endereco, operador: S.op,
        linhas: linhas.map(l => ({ data_lancamento: l.data_lancamento || '', ean: l.ean, lote: l.lote, validade: l.validade, qtd: l.qtd, nome: l.nome || undefined })),
      } });
      const falhou = new Map(r.falhas.map(f => [f.n - 1, f.erro]));
      const idx = linhas.map(l => st.linhas.indexOf(l));
      idx.forEach((gi, k) => {
        if (falhou.has(k)) { const l = st.linhas[gi]; l.erroLancar = falhou.get(k); l.status = 'duvidosa'; l.incluir = false; l.precisaCorrigir = true; }
        else st.linhas[gi].descartada = true;   // lançada: sai da tela
      });
      if (!r.falhas.length) { st.resultado = r; st.fase = 'fim'; if (typeof carregaResumo === 'function') carregaResumo().catch(() => {}); }
      else { toast(`${r.lancadas} lançado(s); ${r.falhas.length} linha(s) precisam de correção`, 'bad', 5000); st.envio = uuid(); }
    } catch (e) { toast(e.message, 'bad', 5000); }
    desenha();
  }

  function onClick(e) {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.sug !== undefined) {
      const l = st.linhas[+t.dataset.sug]; l.ean = t.dataset.ean; l.incluir = true; l.motivos = l.motivos.filter(m => !/EAN|parecido/.test(m)); l.precisaCorrigir = false;
      desenha();
    } else if (t.dataset.descartar !== undefined) { st.linhas[+t.dataset.descartar].descartada = true; desenha(); }
    else if (t.id === 'folhaLancar') lancar();
    else if (t.id === 'folhaOutra' || t.id === 'folhaNova') { const e0 = st.endereco; reset(); st.endereco = e0; desenha(); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === 'folhaArq' && t.files[0]) aoEscolherFoto(t.files[0]);
    else if (t.dataset.incluir !== undefined) { st.linhas[+t.dataset.incluir].incluir = t.checked; desenha(); }
  }
  function onInput(e) {
    const t = e.target;
    if (t.id === 'folhaEnd') st.endereco = t.value.trim().toUpperCase();
    else if (t.dataset.k) {
      const l = st.linhas[+t.dataset.i]; l[t.dataset.k] = t.value;
      if (!l.incluir) { l.incluir = true; const cb = $(`[data-incluir="${t.dataset.i}"]`, raiz()); if (cb) cb.checked = true; const b = $('#folhaLancar'); if (b) atualizaBotao(); }
      else atualizaBotao();
    }
  }
  function atualizaBotao() {
    const n = st.linhas.filter(l => !l.descartada && l.incluir).length, b = $('#folhaLancar');
    if (b) { b.disabled = !n; b.innerHTML = `${ico('check')} Lançar ${n} lote${n === 1 ? '' : 's'}`; }
  }

  return { html, ligar };
})();
