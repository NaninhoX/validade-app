// Função da Vercel: todas as rotas /api/* passam por aqui (vercel.json reescreve /api/* para este arquivo;
// os arquivos de public/ são servidos direto pela Vercel).
const { handler } = require('../lib/app');

module.exports = (req, res) => {
  // garante o prefixo /api caso a plataforma entregue o caminho reescrito
  if (!req.url.startsWith('/api')) req.url = '/api' + (req.url.startsWith('/') ? '' : '/') + req.url;
  res.setHeader('x-debug-url', req.url);
  return handler(req, res);
};
