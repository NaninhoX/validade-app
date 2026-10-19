// Uso: node scripts/import.js <arquivo.xlsx> [--substituir]
//   Local: grava em data/validade.db. Remoto: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN antes de rodar.
const path = require('node:path');
const { open } = require('../lib/db');
const { importar } = require('../lib/excel');

(async () => {
  const arquivo = process.argv[2];
  if (!arquivo) { console.error('Uso: node scripts/import.js <arquivo.xlsx> [--substituir]'); process.exit(1); }
  const db = await open();
  const t0 = Date.now();
  const rel = await importar(db, path.resolve(arquivo), { substituir: process.argv.includes('--substituir') });
  console.log(JSON.stringify({ banco: db.url.replace(/\/\/[^@]*@/, '//'), ...rel, ignoradas: rel.ignoradas.slice(0, 20), avisos: rel.avisos.slice(0, 20), segundos: (Date.now() - t0) / 1000 }, null, 2));
  db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
