const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const U = require('../lib/util');
const X = require('../lib/excel');
const C = require('../lib/causas');

let compartilhado;
async function novoDb() {
  if (!compartilhado) compartilhado = await open({ dir: 'memory://' });
  const db = compartilhado;
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20, categoria: 'RAÇÃO' });
  U.setAreas([19]);
  return db;
}
test.after(() => compartilhado && compartilhado.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };
const base = { ean: '7891000000017', lote: 'L1', validade: mais(100), endereco: '3-A-1', operador: 'TESTE' };
const recebe = (db, extra = {}) => S.leitura(db, { tipo: 'RECEBIMENTO', ...base, qtd: 20, ...extra });
const baixa = (db, loteId, extra = {}) => S.leitura(db, { tipo: 'BAIXA', lote_id: loteId, operador: 'TESTE', qtd: 2, ...extra });

test('causa: obrigatória em RMA/Avaria/Retirada Preventiva, opcional em Venda; mensagens em português', async () => {
  const db = await novoDb();
  const id = (await recebe(db)).lote.id;
  for (const motivo of ['RMA', 'Avaria', 'Retirada Preventiva']) {
    await assert.rejects(baixa(db, id, { motivo }), e => e.status === 400 && /causa/i.test(e.message));
  }
  await assert.rejects(baixa(db, id, { motivo: 'RMA', causa: 'Inventada' }), e => e.status === 400 && /inválida/i.test(e.message));
  await baixa(db, id, { motivo: 'Venda' });
  const lote = await db.get('SELECT qtd FROM lotes WHERE id=?', [id]);
  assert.equal(lote.qtd, 18);                      // só a venda baixou; as recusadas não mexeram no saldo
});

test('causa: gravada no evento BAIXA e devolvida por eventos()', async () => {
  const db = await novoDb();
  const id = (await recebe(db)).lote.id;
  await baixa(db, id, { motivo: 'RMA', causa: 'Giro baixo' });
  const evs = await S.eventos(db, { tipo: 'BAIXA' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].causa, 'Giro baixo');
  assert.equal(evs[0].motivo, 'RMA');
  assert.equal((await S.eventos(db, { tipo: 'RECEBIMENTO' }))[0].causa, null);
});

test('causa: Pareto (soma, %, % acumulado, ordem) e evento antigo vira "Sem causa registrada"', async () => {
  const db = await novoDb();
  const id = (await recebe(db, { qtd: 100 })).lote.id;      // preço 20
  await baixa(db, id, { motivo: 'RMA', causa: 'Giro baixo', qtd: 6 });
  await baixa(db, id, { motivo: 'Avaria', causa: 'Giro baixo', qtd: 2 });
  await baixa(db, id, { motivo: 'RMA', causa: 'Comprei demais', qtd: 1 });
  await baixa(db, id, { motivo: 'Venda', qtd: 50 });                       // venda não entra
  await db.run(`INSERT INTO eventos(ts,tipo,lote_id,ean,delta,operador,motivo,grupo) VALUES(?,?,?,?,?,?,?,?)`,
    [new Date().toISOString(), 'BAIXA', id, base.ean, -1, 'ANTIGO', 'RMA', 'g-antigo']);
  await db.run(`INSERT INTO eventos(ts,tipo,lote_id,ean,delta,operador,motivo,causa,grupo) VALUES(?,?,?,?,?,?,?,?,?)`,
    [new Date(Date.now() - 45 * 864e5).toISOString(), 'BAIXA', id, base.ean, -7, 'X', 'RMA', 'Outro', 'g-velho']);
  const p30 = await C.pareto(db, 30), p90 = await C.pareto(db, 90);
  assert.deepEqual(p30.itens.map(i => [i.causa, i.qtd]), [['Giro baixo', 8], ['Comprei demais', 1], ['Sem causa registrada', 1]]);
  assert.equal(p30.total_qtd, 10);
  assert.deepEqual(p30.itens.map(i => i.pct), [80, 10, 10]);
  assert.deepEqual(p30.itens.map(i => i.pct_acum), [80, 90, 100]);
  assert.equal(p30.itens[0].valor, 160);                                   // 8 × R$ 20
  assert.equal(p90.total_qtd, 17);
  assert.equal(p90.itens.find(i => i.causa === 'Outro').qtd, 7);
  await assert.rejects(C.pareto(db, 15), e => e.status === 400);
});

test('causa: baixa desfeita sai do Pareto; Pareto vazio', async () => {
  const db = await novoDb();
  const id = (await recebe(db)).lote.id;
  const r = await baixa(db, id, { motivo: 'RMA', causa: 'Outro', qtd: 3 });
  await S.desfazer(db, r.grupo);
  assert.deepEqual((await C.pareto(db, 30)).itens, []);
  assert.deepEqual(C.montarPareto([]), { total_qtd: 0, total_valor: 0, itens: [] });
});

test('causa: exportação .xlsx continua gerando com a coluna nova', async () => {
  const db = await novoDb();
  const id = (await recebe(db)).lote.id;
  await baixa(db, id, { motivo: 'Avaria', causa: 'Ficou escondido ou mal exposto' });
  assert.ok(Buffer.from(await X.exportar(db)).length > 1000);
});
