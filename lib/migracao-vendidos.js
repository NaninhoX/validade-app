// Migração única: a planilha antiga deixava na FIFO as linhas já vendidas ("✅ Vendido") e as descartadas ("❌ Descartado"), e a carga inicial
// trouxe tudo isso para o estoque como se ainda estivesse na prateleira. Aqui cada uma vira uma baixa no histórico e sai do estoque:
//   ✅ Vendido     -> baixa por Venda, na data da "Última atualização" da planilha (a linha inteira foi vendida)
//   ❌ Descartado  -> baixa por RMA (foi para o CD), sem causa informada
// As baixas ficam marcadas como histórico importado (não dá para desfazer sem querer). A Perda potencial evitada não muda: passa de
// "lote antigo marcado vendido" para "venda registrada". Só roda uma vez (marca em config) e aceita simulação.
const crypto = require('node:crypto');
const U = require('./util');

const ehVendido = a => /vendido/i.test(a || '');
const ehDescartado = a => /descartado/i.test(a || '');

async function baixarVendidos(db, { simular = false } = {}) {
  return db.tx(async t => {
    const feito = await t.get("SELECT valor FROM config WHERE chave='migracao_vendidos'");
    if (feito) return { ja_feita: true, quando: JSON.parse(feito.valor).quando };
    const lotes = (await t.all('SELECT l.id, l.ean, l.lote, l.validade, l.endereco, l.qtd, l.acao, l.atualizado_em, p.preco FROM lotes l LEFT JOIN produtos p ON p.ean = l.ean WHERE l.qtd > 0 ORDER BY l.id'))
      .filter(l => ehVendido(l.acao) || ehDescartado(l.acao));
    const rel = { quando: U.agoraISO(), vendidos: { lotes: 0, unidades: 0, valor: 0 }, descartados: { lotes: 0, unidades: 0, valor: 0 }, eventos: 0, simulado: !!simular };
    for (const l of lotes) {
      const venda = ehVendido(l.acao), q = Number(l.qtd), valor = l.preco === null || l.preco === undefined ? 0 : Number(l.preco) * q;
      const alvo = venda ? rel.vendidos : rel.descartados;
      alvo.lotes++; alvo.unidades += q; alvo.valor += valor;
      if (simular) continue;
      const ts = l.atualizado_em && !isNaN(Date.parse(l.atualizado_em)) ? new Date(l.atualizado_em).toISOString() : U.agoraISO();
      await t.run(`INSERT INTO eventos(ts,tipo,lote_id,ean,lote,validade,endereco,delta,qtd_antes,qtd_depois,operador,motivo,obs,client_id,grupo,historico)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [ts, 'BAIXA', l.id, l.ean, l.lote, l.validade, l.endereco, -q, q, 0, 'MIGRAÇÃO', venda ? 'Venda' : 'RMA',
        `Planilha antiga: ${venda ? '✅ Vendido' : '❌ Descartado'}, baixa importada para tirar do estoque`, `migracao-vendidos-${l.id}`, crypto.randomUUID()]);
      await t.run('UPDATE lotes SET qtd=0, atualizado_em=? WHERE id=?', [ts, l.id]);
      rel.eventos++;
    }
    for (const x of [rel.vendidos, rel.descartados]) x.valor = +x.valor.toFixed(2);
    if (!simular) await t.run("INSERT INTO config(chave,valor) VALUES('migracao_vendidos', ?)", [JSON.stringify(rel)]);
    return rel;
  });
}

module.exports = { baixarVendidos };
