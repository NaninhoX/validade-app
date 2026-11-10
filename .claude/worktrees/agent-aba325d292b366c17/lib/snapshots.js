// Fotografia diária do estoque. O estoque é derivado de eventos e não guarda estados passados;
// esta tabela guarda, no máximo, uma linha por dia com os totais, criada de forma preguiçosa
// (na primeira vez em que o dia é consultado). Nunca reconstruímos nem inventamos dias que não foram registrados.
const U = require('./util');

const soma = (ls, f) => +ls.reduce((s, l) => s + (f(l) ? (l.valor || 0) : 0), 0).toFixed(2);

// `lotes`: saída de lotesAtivos (já enriquecida, com dias/peso/valor).
function calcular(lotes) {
  return {
    vencido_valor: soma(lotes, l => l.dias <= 0),
    vencido_lotes: lotes.filter(l => l.dias <= 0).length,
    valor_risco: soma(lotes, l => l.peso > 0),
    valor_total: soma(lotes, () => true),
    lotes: lotes.length,
  };
}

// Idempotente e seguro com requisições simultâneas: a chave primária decide quem grava; as demais ignoram.
async function registrarHoje(db, lotes, hoje = U.hojeISO()) {
  const existe = await db.get('SELECT data FROM snapshots_diarios WHERE data = ?', [hoje]);
  if (existe) return false;
  const s = calcular(lotes);
  const r = await db.run(
    `INSERT INTO snapshots_diarios (data, vencido_valor, vencido_lotes, valor_risco, valor_total, lotes)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (data) DO NOTHING`,
    [hoje, s.vencido_valor, s.vencido_lotes, s.valor_risco, s.valor_total, s.lotes]);
  return r.changes > 0;
}

// Nunca deixa a gravação do snapshot derrubar quem chamou.
const registrarSeguro = (db, lotes, hoje) => registrarHoje(db, lotes, hoje).catch(e => { console.error('snapshot:', e.message); return false; });

const listar = (db, desde) => db.all('SELECT * FROM snapshots_diarios WHERE data >= ? ORDER BY data', [desde]);

module.exports = { calcular, registrarHoje, registrarSeguro, listar };
