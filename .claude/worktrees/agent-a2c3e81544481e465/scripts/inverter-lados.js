// Uso: npm run inverter-lados      (lê DATABASE_URL de .env.local; sem ela usa o banco local em data/pg)
// Faz um backup .xlsx em backups/ e troca A↔B nos endereços das gôndolas 11 a 18. Só roda uma vez.
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const X = require('../lib/excel');
const { inverterLados } = require('../lib/migracao');
const U = require('../lib/util');

(async () => {
  const db = await open();
  try {
    fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true });
    const arq = path.join(__dirname, '..', 'backups', `antes-inverter-lados_${U.hojeISO()}_${Date.now()}.xlsx`);
    fs.writeFileSync(arq, Buffer.from(await X.exportar(db)));
    console.log('Backup salvo em', arq);
    const r = await inverterLados(db);
    console.log(r.ja_feita ? `Já executada em ${r.quando}. Nada a fazer.` : `Pronto: ${r.lotes} lotes trocados (${r.somados} somados a outro do mesmo lote), ${r.eventos} movimentações ajustadas.`);
  } finally { await db.close(); }
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
