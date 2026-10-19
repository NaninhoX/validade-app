  $('#logo').innerHTML = ico('box', 28);
  $('#nome').value = lsGet('ultimoNome', '');
  (lsGet('ultimoNome', '') ? $('#pin') : $('#nome')).focus();
  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    $('#err').textContent = ''; $('#ok').disabled = true;
    try {
      const u = await api('/api/login', { method: 'POST', body: { nome: $('#nome').value, pin: $('#pin').value }, semRedirect: true });
      lsSet('ultimoNome', u.nome);
      const volta = new URLSearchParams(location.search).get('volta');
      location.href = volta && volta.startsWith('/') && !volta.startsWith('//') ? volta : '/';
    } catch (er) {
      $('#err').textContent = er.message;
      $('#f').classList.remove('shake'); void $('#f').offsetWidth; $('#f').classList.add('shake');
      $('#pin').value = ''; $('#pin').focus(); $('#ok').disabled = false;
    }
  });
