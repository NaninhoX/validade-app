// Uso: node scripts/usuario.js NOME PIN [admin|operador]
//   Cria o usuário ou troca o PIN/papel. Funciona no banco local e no remoto (defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN).
const { open } = require('../lib/db');
const { salvarUsuario } = require('../lib/auth');

(async () => {
  const [nome, pin, papel = 'operador'] = process.argv.slice(2);
  if (!nome || !pin) { console.error('Uso: node scripts/usuario.js NOME PIN [admin|operador]   (PIN: 6 a 8 números)'); process.exit(1); }
  const db = await open();
  const n = await salvarUsuario(db, { nome, pin, papel, ativo: true });
  console.log(`Usuário ${n} salvo como ${papel}.`);
  db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
