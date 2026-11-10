// Causa da perda: por que o item foi baixado (RMA, avaria, retirada preventiva). Base do Pareto de causas.
const { HttpError } = require('./util');

const CAUSAS = [
  'Comprei demais',
  'Giro baixo',
  'Entrou com pouco prazo',
  'Ficou escondido ou mal exposto',
  'Etiqueta/promoção não feita a tempo',
  'Outro',
];
const MOTIVOS_COM_CAUSA = ['RMA', 'Avaria', 'Retirada Preventiva'];
const SEM_CAUSA = 'Sem causa registrada';

// Devolve a causa a gravar (ou null). Lança 400 em português se faltar ou for inválida onde é obrigatória.
function validarCausa(motivo, causa) {
  const c = causa === undefined || causa === null || String(causa).trim() === '' ? null : String(causa).trim();
  if (MOTIVOS_COM_CAUSA.includes(motivo)) {
    if (!c) throw new HttpError(400, `Informe a causa da perda (obrigatória para ${motivo}): ${CAUSAS.join('; ')}`);
    if (!CAUSAS.includes(c)) throw new HttpError(400, `Causa inválida. Use uma destas: ${CAUSAS.join('; ')}`);
    return c;
  }
  if (c && !CAUSAS.includes(c)) throw new HttpError(400, `Causa inválida. Use uma destas: ${CAUSAS.join('; ')}`);
  return c;   // em Venda e demais motivos é opcional (normalmente vazia)
}

// rows: [{ causa, qtd, valor }] → Pareto ordenado, com % e % acumulado (pela quantidade)
function montarPareto(rows) {
  const mapa = new Map();
  for (const r of rows) {
    const k = r.causa || SEM_CAUSA;
    const x = mapa.get(k) || { causa: k, qtd: 0, valor: 0 };
    x.qtd += Number(r.qtd) || 0;
    x.valor += Number(r.valor) || 0;
    mapa.set(k, x);
  }
  const lista = [...mapa.values()].sort((a, b) => b.qtd - a.qtd || b.valor - a.valor || a.causa.localeCompare(b.causa, 'pt-BR'));
  const total_qtd = lista.reduce((s, x) => s + x.qtd, 0);
  const total_valor = lista.reduce((s, x) => s + x.valor, 0);
  const r1 = n => Math.round(n * 10) / 10;
  let acum = 0;
  const itens = lista.map(x => {
    acum += x.qtd;
    return { causa: x.causa, qtd: x.qtd, valor: Math.round(x.valor * 100) / 100, pct: total_qtd ? r1(x.qtd / total_qtd * 100) : 0, pct_acum: total_qtd ? r1(acum / total_qtd * 100) : 0 };
  });
  return { total_qtd, total_valor: Math.round(total_valor * 100) / 100, itens };
}

async function pareto(db, dias = 30) {
  dias = +dias || 30;
  if (![30, 90].includes(dias)) throw new HttpError(400, 'dias deve ser 30 ou 90');
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const rows = await db.all(
    `SELECT e.causa, SUM(-e.delta) AS qtd, SUM(CASE WHEN p.preco IS NOT NULL THEN -e.delta * p.preco ELSE 0 END) AS valor,
            SUM(CASE WHEN p.preco IS NULL THEN -e.delta ELSE 0 END) AS qtd_sem_preco
       FROM eventos e LEFT JOIN produtos p ON p.ean = e.ean
      WHERE e.tipo = 'BAIXA' AND e.desfeito = 0 AND e.ts >= ?
        AND (e.causa IS NOT NULL OR e.motivo IN (${MOTIVOS_COM_CAUSA.map(() => '?').join(',')}))
      GROUP BY e.causa`, [desde, ...MOTIVOS_COM_CAUSA]);
  const r = montarPareto(rows);
  return { dias, ...r, qtd_sem_preco: rows.reduce((s, x) => s + (Number(x.qtd_sem_preco) || 0), 0) };
}

module.exports = { CAUSAS, MOTIVOS_COM_CAUSA, SEM_CAUSA, validarCausa, montarPareto, pareto };
