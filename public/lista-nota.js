'use strict';
// Carregar a lista da nota ou da contagem do sistema da loja numa Conferência (Recebimento ou Contagem).
// Aceita planilha (.xlsx), CSV, TXT e XML da NF-e. O servidor só analisa; aqui a pessoa vê o que foi entendido e confirma.
const ListaNota = (() => {
  const lerBase64 = f => new Promise((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok({ nome: f.name, base64: String(r.result).split(',')[1] || '' });
    r.onerror = () => erro(new Error('não consegui ler ' + f.name));
    r.readAsDataURL(f);
  });

  function abre({ conferencia, recarrega }) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.xlsx,.csv,.txt,.xml,text/csv,text/plain,text/xml,application/xml';
    inp.addEventListener('change', async () => {
      const arqs = [...inp.files]; if (!arqs.length) return;
      try {
        toast('Lendo o arquivo…', '', 1500);
        const r = await api('/api/importar/analisar', { method: 'POST', body: { arquivos: await Promise.all(arqs.map(lerBase64)) } });
        mostra(r, conferencia, recarrega);
      } catch (e) { toast(e.message, 'bad', 7000); }
    });
    inp.click();
  }

  function mostra(r, conf, recarrega) {
    const ok = r.linhas.filter(l => !l.erros.length && l.ean);
    const ruins = r.linhas.filter(l => l.erros.length || l.avisos.length);
    const dlg = document.createElement('dialog');
    dlg.className = 'ln';
    const nota = r.resumo.arquivos.map(a => a.nota).find(Boolean);
    const aviso = r.resumo.arquivos.some(a => a.sem_cabecalho) ? '<div class="callout" style="margin:8px 0">' + ico('info') + '<div>O arquivo não tem cabeçalho: entendi a 1ª coluna como EAN e a 2ª como quantidade.</div></div>' : '';
    const linha = l => `<tr class="${l.erros.length ? 'ruim' : l.avisos.length ? 'aviso' : ''}"><td>${l.n}</td><td>${esc(l.ean || '—')}</td><td>${esc(l.nome || (l.cadastrado ? '' : 'não cadastrado'))}</td><td>${l.qtd ?? '—'}</td><td>${esc([...l.erros, ...l.avisos].join('; '))}</td></tr>`;
    const mostradas = [...ruins, ...ok.filter(l => !ruins.includes(l))].slice(0, 40);
    dlg.innerHTML = `<h2 style="margin:0 0 4px">Carregar lista</h2>
      <div class="muted small">${r.resumo.arquivos.map(a => esc(a.nome) + ' (' + a.formato.toUpperCase() + ', ' + a.linhas + ' linhas)').join(' · ')}${nota ? ' · NF ' + esc(nota.numero) + (nota.emitente ? ' de ' + esc(nota.emitente) : '') : ''}</div>
      <div class="ln-resumo"><span class="rc ok">${ok.length} para carregar</span>${r.resumo.com_erro ? `<span class="rc bad">${r.resumo.com_erro} com problema (ficam de fora)</span>` : ''}${r.resumo.nao_cadastrados ? `<span class="rc warn">${r.resumo.nao_cadastrados} sem cadastro no app</span>` : ''}</div>
      ${aviso}
      <div class="ln-tab"><table><thead><tr><th>Linha</th><th>EAN</th><th>Produto</th><th>Qtd</th><th>Observação</th></tr></thead><tbody>${mostradas.map(linha).join('')}</tbody></table></div>
      <div class="xs muted" style="margin-top:6px">${r.linhas.length > mostradas.length ? `Mostrando ${mostradas.length} de ${r.linhas.length} linhas (os problemas primeiro). ` : ''}As quantidades do arquivo viram o “esperado”; a contagem começa zerada. Produto sem cadastro entra com o nome da nota, quando houver.</div>
      <div class="editbar" style="justify-content:flex-end;margin-top:14px"><button id="lnNao">Cancelar</button><button class="primary" id="lnSim" ${ok.length ? '' : 'disabled'}>${ico('check')} Carregar ${ok.length} produto${ok.length === 1 ? '' : 's'}</button></div>`;
    document.body.appendChild(dlg);
    const fecha = () => { dlg.close(); dlg.remove(); };
    dlg.querySelector('#lnNao').addEventListener('click', fecha);
    dlg.addEventListener('cancel', () => dlg.remove());
    dlg.querySelector('#lnSim').addEventListener('click', async () => {
      const b = dlg.querySelector('#lnSim'); b.disabled = true;
      try {
        const res = await api('/api/conferencias/' + conf.id + '/esperado', { method: 'POST', body: { linhas: ok.map(l => ({ ean: l.ean, qtd: l.qtd, nome: l.nome })), nota: nota && nota.numero } });
        fecha();
        toast(res.total + ' produtos carregados como esperado', 'ok', 3500);
        await recarrega();
      } catch (e) { toast(e.message, 'bad', 6000); b.disabled = false; }
    });
    dlg.showModal();
  }

  return { abre };
})();
