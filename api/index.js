// Função da Vercel: todas as rotas /api/* passam por aqui (vercel.json reescreve /api/* para este arquivo;
// os arquivos de public/ são servidos direto pela Vercel).
const { handler } = require('../lib/app');

module.exports = (req, res) => {
  // A Vercel mantém o caminho original e acrescenta ?path=… na reescrita; tira esse parâmetro para o roteador não vê-lo.
  const u = new URL(req.url, 'http://x');
  u.searchParams.delete('path');
  req.url = u.pathname + u.search;
  return handler(req, res);
};
