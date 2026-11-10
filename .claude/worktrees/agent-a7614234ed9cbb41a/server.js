const http = require('node:http');
const os = require('node:os');
const { handler } = require('./lib/app');
const { loginObrigatorio } = require('./lib/auth');

const PORT = +process.env.PORT || 3000;
const LAN = process.argv.includes('--lan') || process.env.HOST === '0.0.0.0';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

const server = http.createServer((req, res) => handler(req, res, { estaticos: true }));

server.listen(PORT, HOST, () => {
  console.log('Controle de Validade rodando');
  console.log(`  Dashboard: http://localhost:${PORT}/`);
  console.log(`  Coletor:   http://localhost:${PORT}/coletor`);
  console.log(`  Login:     ${loginObrigatorio() ? 'obrigatório (crie usuários com: npm run usuario -- NOME PIN admin)' : 'desligado (só neste computador)'}`);
  if (LAN) {
    for (const lista of Object.values(os.networkInterfaces()))
      for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Na rede:   http://${i.address}:${PORT}/coletor`);
  }
});
