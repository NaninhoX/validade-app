const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const U = require('../lib/util');
const Snap = require('../lib/snapshots');
const W = require('../lib/semanal');

let db;
async function novoDb() {
  if (!db) db = await open({ dir: 'memory://' });
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config, snapshots_diarios RESTART IDENTITY');
  U.setAreas([19]);
  return db;
}
test.after(() => db && db.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };

async function estoque(db) {
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO A', preco: 20, categoria: 'RAÇÃO', marca: 'ALFA' });
  await S.upsertProduto(db, { ean: '7891000000024', nome: 'BOLA', preco: 10, categoria: 'ACESSÓRIO', marca: 'BETA' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000017', lote: 'V1', validade: mais(-5), qtd: 3, endereco: '3-A-1', operador: 'T' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000024', lote: 'V2', validade: mais(200), qtd: 2, endereco: '4-B-1', operador: 'T' });
}

test('snapshot: resumo grava uma linha por dia, idempotente e concorrente', async () => {
  const db = await novoDb();
  await estoque(db);
  await Promise.all([S.resumo(db), S.resumo(db), S.resumo(db)]);
  await S.resumo(db);
  const rows = await db.all('SELECT * FROM snapshots_diarios');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data, U.hojeISO());
  assert.equal(rows[0].vencido_lotes, 1);
  assert.equal(rows[0].vencido_valor, 60);
  assert.equal(rows[0].lotes, 2);
  assert.equal(rows[0].valor_total, 80);
  assert.equal(await Snap.registrarHoje(db, []), false);       // já existe: não sobrescreve
  assert.equal((await db.get('SELECT vencido_valor FROM snapshots_diarios')).vencido_valor, 60);
});

test('variacao: delta, percentual e sentido', () => {
  assert.deepEqual(W.variacao(120, 100), { atual: 120, anterior: 100, delta: 20, delta_pct: 20, sentido: 'pior' });
  assert.equal(W.variacao(80, 100).sentido, 'melhor');
  assert.equal(W.variacao(4, 2, false).sentido, 'melhor');       // rondas: subir é bom
  assert.equal(W.variacao(5, 5).sentido, 'igual');
  assert.equal(W.variacao(10, 0).delta_pct, null);               // base zero: sem percentual
  const sem = W.variacao(10, null);
  assert.equal(sem.delta, null); assert.equal(sem.sentido, null);
});

test('pareto: percentual e acumulado sobre o total de todos', () => {
  const itens = [{ nome: 'A', perda: 50 }, { nome: 'B', perda: 30 }, { nome: 'C', perda: 10 }, { nome: 'D', perda: 5 }, { nome: 'E', perda: 3 }, { nome: 'F', perda: 2 }, { nome: 'Z', perda: 0 }];
  const p = W.pareto(itens, 5);
  assert.equal(p.total, 100);
  assert.deepEqual(p.itens.map(i => i.nome), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(p.itens.map(i => i.pct), [50, 30, 10, 5, 3]);
  assert.deepEqual(p.itens.map(i => i.acum), [50, 80, 90, 95, 98]);
  assert.equal(p.outros, 1);
  assert.deepEqual(W.pareto([], 5), { total: 0, itens: [], outros: 0 });
});

test('decisoes: frases a partir dos números', () => {
  const marcas = W.pareto([{ nome: 'X', perda: 40 }, { nome: 'Y', perda: 14 }, { nome: 'W', perda: 8 }, { nome: 'Q', perda: 38 }]);
  const gondolas = W.pareto([{ nome: 'Gôndola 3', perda: 70 }, { nome: 'Gôndola 4', perda: 30 }]);
  const kpis = { vencido_valor: W.variacao(500, 300), divergencia: W.variacao(12, 5), rondas: W.variacao(3, 5, false) };
  const d = W.decisoes({ marcas, gondolas, kpis, rondas: { dias_este: 3, meta: 6 }, pendentes: { total: 2 } });
  assert.match(d[0], /^3 marcas concentram 92% da perda: rever o pedido de X, Q e Y\.$/);
  assert.ok(d.some(x => /Gôndola 3 concentra 70%/.test(x)));
  assert.ok(d.some(x => /subiu R\$ 200/.test(x)));
  assert.ok(d.some(x => /Só 3 de 6 rondas/.test(x)));
  assert.ok(d.some(x => /Divergência da ronda em 12%/.test(x)));
  assert.ok(d.some(x => /2 gôndolas sem ronda há mais de 14 dias/.test(x)));
  const vazio = W.decisoes({ marcas: W.pareto([]), gondolas: W.pareto([]), kpis: { vencido_valor: W.variacao(0, null), divergencia: W.variacao(null, null) }, rondas: { dias_este: 6, meta: 6 }, pendentes: { total: 0 } });
  assert.deepEqual(vazio, []);
});

test('briefing semanal sem histórico: sem comparação inventada', async () => {
  const db = await novoDb();
  await estoque(db);
  const b = await W.briefingSemanal(db);
  assert.equal(b.kpis.vencido_valor.atual, 60);
  assert.equal(b.kpis.vencido_valor.anterior, null);
  assert.equal(b.kpis.vencido_valor.delta, null);
  assert.equal(b.historico.inicio, U.hojeISO());
  assert.equal(b.historico.completo, false);
  assert.equal(b.historico.semanas_com_dado, 1);
  assert.deepEqual(b.tendencia.map(t => t.valor), [null, null, null, 60]);
  assert.equal(b.marcas.itens[0].nome, 'ALFA');
  assert.equal(b.kpis.rondas.atual, 0);
  assert.ok(b.decisoes.length > 0);
  assert.equal(b.pendentes.total, 2);                            // gôndolas 3 e 4 nunca contadas
});

test('briefing semanal com histórico: deltas e tendência de 4 semanas', async () => {
  const db = await novoDb();
  await estoque(db);
  const hoje = U.hojeISO();
  const ins = (d, v, l) => db.run('INSERT INTO snapshots_diarios VALUES (?,?,?,?,?,?)', [W.addDias(hoje, d), v, l, v + 10, v + 100, 9]);
  await ins(-21, 10, 1); await ins(-14, 20, 1); await ins(-7, 30, 1);
  const b = await W.briefingSemanal(db);
  assert.deepEqual(b.tendencia.map(t => t.valor), [10, 20, 30, 60]);
  assert.equal(b.kpis.vencido_valor.delta, 30);
  assert.equal(b.kpis.vencido_valor.delta_pct, 100);
  assert.equal(b.kpis.vencido_valor.sentido, 'pior');
  assert.equal(b.historico.completo, true);
  assert.ok(b.decisoes.some(x => /Vencido em estoque subiu R\$ 30/.test(x)));
});
