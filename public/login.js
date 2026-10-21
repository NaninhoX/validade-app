  $('#logo').innerHTML = ico('box', 28);
  $('#nome').value = lsGet('ultimoNome', '');
  (lsGet('ultimoNome', '') ? $('#pin') : $('#nome')).focus();
  $('#pin').addEventListener('input', () => { const v = $('#pin').value, s = v.replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), ''); if (v !== s) $('#pin').value = s; });   // só números, mesmo se vier colado com espaço
  $('#ver').addEventListener('click', () => { const p = $('#pin'); const mostra = p.type === 'password'; p.type = mostra ? 'text' : 'password'; $('#ver').textContent = mostra ? 'ocultar' : 'ver'; p.focus(); });
  if (lsGet('ultimoNome', '')) { const o = $('#outro'); o.hidden = false; o.addEventListener('click', e => { e.preventDefault(); $('#nome').value = ''; o.hidden = true; $('#nome').focus(); }); }
  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    $('#err').textContent = '';
    const nome = $('#nome').value.trim(), pin = $('#pin').value.replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), '');
    const falha = msg => { $('#err').textContent = msg; $('#f').classList.remove('shake'); void $('#f').offsetWidth; $('#f').classList.add('shake'); };
    if (!nome) { falha('Digite o seu nome.'); return $('#nome').focus(); }
    if (pin.length < 6 || pin.length > 8) { falha('O PIN tem de 6 a 8 números (você digitou ' + pin.length + ').'); return $('#pin').focus(); }
    $('#ok').disabled = true;
    try {
      const u = await api('/api/login', { method: 'POST', body: { nome, pin }, semRedirect: true });
      lsSet('ultimoNome', u.nome);
      const volta = new URLSearchParams(location.search).get('volta');
      location.href = volta && volta.startsWith('/') && !volta.startsWith('//') ? volta : '/';
    } catch (er) {
      $('#err').textContent = er.message;
      $('#f').classList.remove('shake'); void $('#f').offsetWidth; $('#f').classList.add('shake');
      $('#pin').value = ''; $('#pin').focus(); $('#ok').disabled = false;
    }
  });
