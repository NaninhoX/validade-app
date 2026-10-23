// Uso: npm run baixar-vendidos [-- --simular]   (lê DATABASE_URL de .env.local; sem ela usa o banco local em data/pg)
// Faz um backup .xlsx em backups/ e dá baixa nos lotes da planilha antiga marcados ✅ Vendido (Venda) e ❌ Descartado (RMA). Só roda uma vez.
// Com --simular não altera nada: só mostra o que mudaria.
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../lib/db');
const X = require('../lib/excel');
const S = require('../lib/service');
const { baixarVendidos } = require('../lib/migracao-vendidos');
const U = require('../lib/util');

const brl = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function foto(db) {
  const l = await S.lotesAtivos(db), venc = l.filter(x => x.dias <= 0);
  const ev = await S.evitada(db, {});
  return { lotes: l.length, itens: l.reduce((s, x) => s + x.qtd, 0), valor: l.reduce((s, x) => s + (x.valor || 0), 0), vencLotes: venc.length, vencValor: venc.reduce((s, x) => s + (x.valor || 0), 0), evitada: ev.evitada };
}

(async () => {
  const simular = process.argv.includes('--simular');
  const db = await open();
  try {
    const antes = await foto(db);
    if (!simular) {
      fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true });
      const arq = path.join(__dirname, '..', 'backups', `antes-baixar-vendidos_${U.hojeISO()}_${Date.now()}.xlsx`);
      fs.writeFileSync(arq, Buffer.from(await X.exportar(db)));
      console.log('Backup salvo em', arq);
    }
    const r = await baixarVendidos(db, { simular });
    if (r.ja_feita) { console.log(`Já executada em ${r.quando}. Nada a fazer.`); return; }
    console.log(`${simular ? 'SIMULAÇÃO (nada foi alterado)' : 'Feito'}:`);
    console.log(`  ✅ Vendido:    ${r.vendidos.lotes} lotes, ${r.vendidos.unidades} un., ${brl(r.vendidos.valor)} a preço cheio`);
    console.log(`  ❌ Descartado: ${r.descartados.lotes} lotes, ${r.descartados.unidades} un., ${brl(r.descartados.valor)} a preço cheio`);
    const dep = simular ? null : await foto(db);
    console.log(`  Estoque antes:  ${antes.lotes} lotes, ${antes.itens} itens, ${brl(antes.valor)}; vencidos ${antes.vencLotes} lotes (${brl(antes.vencValor)}); evitada ${brl(antes.evitada)}`);
    if (dep) console.log(`  Estoque depois: ${dep.lotes} lotes, ${dep.itens} itens, ${brl(dep.valor)}; vencidos ${dep.vencLotes} lotes (${brl(dep.vencValor)}); evitada ${brl(dep.evitada)}`);
  } finally { await db.close(); }
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
