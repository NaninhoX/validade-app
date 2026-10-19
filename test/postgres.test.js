// Mesmo conjunto de verificações nos dois caminhos de produção/desenvolvimento:
//   1) PGlite direto (o que roda localmente)
//   2) driver "pg" falando o protocolo de rede do Postgres (o que roda na Vercel com o Neon) — aqui contra o PGlite exposto por socket
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { open } = require('../lib/db');
const S = require('../lib/service');
const X = require('../lib/excel');
const A = require('../lib/auth');
const U = require('../lib/util');

const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };

async function planilhaDeTeste() {
  const wb = new ExcelJS.Workbook();
  const p = wb.addWorksheet('Produtos');
  p.addRow(['Código', 'Nome', 'Preço(R$)', 'Endereço', 'Marca', 'Tipo', 'Idade', 'Porte', 'Categoria']);
  p.addRow(['7891000000017', 'RAÇÃO SECA TESTE 1KG', 20, '1-A-1', 'TESTE', 'CÃES', 'ADULTO', null, 'RAÇÃO']);
  p.addRow(['7891000000017', 'RAÇÃO SECA TESTE 1KG', null, null, null, null, null, 'PEQUENO', null]);   // EAN repetido: deve mesclar
  p.addRow(['7891000000024', 'BRINQUEDO BOLA', 10, '2-B-2', 'ACME', null, null, null, 'ACESSÓRIO']);
  const f = wb.addWorksheet('FIFO');
  f.addRow(['DATA:']); f.addRow([]); f.addRow([]);
  f.addRow(['Código', 'Nome do Produto', 'Lote', 'Qtd', 'Preço (R$)', 'Validade', 'Endereço', 'Última Atualização', 'Ação Tomada']);
  const d = n => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); x.setUTCHours(0, 0, 0, 0); return x; };
  f.addRow(['7891000000017', 'RAÇÃO', 'L1', 3, 20, d(20), '1-A-1', d(-5), 'Verificado']);
  f.addRow(['7891000000017', 'RAÇÃO', 'L1', 2, 20, d(20), '1-A-1', d(-4), null]);          // mesmo lote repetido: soma
  f.addRow(['7891000000024', 'BOLA', 'B9', 4, 10, d(200), '2-B-2', d(-5), null]);
  f.addRow(['7899999999990', 'PRODUTO FORA DO CADASTRO', 'X', 1, 5, d(40), '3-A-1', d(-5), null]);
  const h = wb.addWorksheet('Historico');
  h.addRow(['Código', 'Lote', 'Qtd', 'Validade', 'Endereço', 'Data da Remoção', 'Motivo da Remoção']);
  h.addRow(['7891000000017', 'OLD', 1, d(-30), '1-A-1', d(-3), 'Vencido']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function suite(nome, abre) {
  let db;
  test(`${nome}: abre o banco e converte tipos numéricos`, async () => {
    db = await abre();
    await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
    await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20.5, categoria: 'RAÇÃO' });
    const r = await db.get('SELECT COUNT(*) n, SUM(preco) s FROM produtos');
    assert.equal(typeof r.n, 'number');                      // COUNT é bigint no Postgres: precisa virar número
    assert.equal(r.s, 20.5);
  });

  test(`${nome}: fluxo de estoque (receber, contar, baixar, transferir, desfazer)`, async () => {
    const base = { ean: '7891000000017', lote: 'L1', validade: mais(100), endereco: '3-A-1', operador: 'TESTE' };
    await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 5, client_id: 'c1' });
    const dup = await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 5, client_id: 'c1' });
    assert.equal(dup.duplicado, true);
    let l = (await S.lotesAtivos(db))[0];
    assert.equal(l.qtd, 5);
    assert.equal(typeof l.id, 'number');
    await S.leitura(db, { ...base, tipo: 'CONTAGEM', qtd: 7 });
    await S.leitura(db, { ...base, tipo: 'BAIXA', qtd: 2, motivo: 'Venda' });
    await assert.rejects(S.leitura(db, { ...base, tipo: 'BAIXA', qtd: 99, motivo: 'Venda' }), /saldo insuficiente/);
    const t = await S.leitura(db, { tipo: 'TRANSFERENCIA', lote_id: (await S.lotesAtivos(db))[0].id, qtd: 3, endereco_destino: '5-B-2', operador: 'TESTE' });
    assert.deepEqual(Object.fromEntries((await S.lotesAtivos(db)).map(x => [x.endereco, x.qtd])), { '3-A-1': 2, '5-B-2': 3 });
    await S.desfazer(db, t.grupo);
    assert.deepEqual(Object.fromEntries((await S.lotesAtivos(db)).map(x => [x.endereco, x.qtd])), { '3-A-1': 5 });
    l = (await S.lotesAtivos(db, { q: 'raç' }))[0];                 // busca sem diferenciar maiúsculas/acentos de caixa
    assert.ok(l);
    assert.ok((await S.lotesAtivos(db, { q: 'RAÇÃO seca' })).length === 1);
  });

  test(`${nome}: dois lançamentos simultâneos no mesmo lote não perdem quantidade`, async () => {
    await db.run('TRUNCATE lotes, eventos RESTART IDENTITY');
    const b = { ean: '7891000000017', lote: 'PAR', validade: mais(100), endereco: '4-B-1', operador: 'TESTE', tipo: 'RECEBIMENTO', qtd: 1 };
    await Promise.all(Array.from({ length: 6 }, (_, i) => S.leitura(db, { ...b, client_id: 'par' + i })));
    assert.equal((await S.lotesAtivos(db, { endereco: '4-B-1' }))[0].qtd, 6);
  });

  test(`${nome}: mapa, resumo, fila e login`, async () => {
    const m = await S.mapa(db);
    assert.ok(m.gondolas.some(g => g.id === 4));
    const r = await S.resumo(db);
    assert.equal(typeof r.totais.valor, 'number');
    assert.ok(Array.isArray(await S.fila(db)));
    await A.salvarUsuario(db, { nome: 'ana', pin: '123456', papel: 'admin' });
    assert.deepEqual(await A.login(db, 'ANA', '123456'), { nome: 'ANA', papel: 'admin' });
    const us = await A.listarUsuarios(db);
    assert.equal(!!us[0].tem_pin, true);
    await S.setLayout(db, S.layoutPadrao());
    assert.equal((await S.getLayout(db)).provisorio, false);
  });

  test(`${nome}: importa planilha (produtos repetidos, lote repetido, EAN fora do cadastro) e exporta`, async () => {
    await db.run('TRUNCATE produtos, lotes, eventos RESTART IDENTITY');
    const rel = await X.importar(db, await planilhaDeTeste(), { substituir: false });
    assert.equal(rel.produtos, 2);
    assert.equal(rel.lotes, 3);
    assert.equal(rel.lotes_agrupados, 1);
    assert.equal(rel.baixas_historico, 1);
    assert.ok(rel.avisos.some(a => a.includes('7899999999990')));
    const lotes = await S.lotesAtivos(db);
    assert.equal(lotes.length, 3);
    assert.equal(lotes.find(l => l.lote === 'L1').qtd, 5);          // 3 + 2
    const p = await S.getProduto(db, '7891000000017');
    assert.equal(p.porte, 'PEQUENO');                               // mesclou a linha repetida
    assert.equal(p.preco, 20);
    assert.equal((await S.getProduto(db, '7899999999990')).ean, '7899999999990');
    await assert.rejects(X.importar(db, await planilhaDeTeste()), /já existem/);
    const again = await X.importar(db, await planilhaDeTeste(), { substituir: true });
    assert.equal(again.lotes, 3);
    assert.equal(Buffer.from(await X.exportar(db)).subarray(0, 2).toString(), 'PK');
  });

  test.after(() => db && db.close());
}

suite('PGlite', () => open({ dir: 'memory://' }));

// driver "pg" de verdade, por rede, contra um servidor Postgres (PGlite exposto por socket)
test('driver pg (rede) — mesma suíte', async t => {
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const pg = new PGlite('memory://');
  await pg.waitReady;
  const server = new PGLiteSocketServer({ db: pg, port: 5498, host: '127.0.0.1' });
  await server.start();
  process.env.PG_POOL_MAX = '1';
  t.after(async () => { await server.stop(); await pg.close(); });
  const db = await open({ url: 'postgres://postgres:postgres@127.0.0.1:5498/postgres?sslmode=disable' });
  t.after(() => db.close());
  assert.equal(db.kind, 'postgres');
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20, categoria: 'RAÇÃO' });
  const n = await db.get('SELECT COUNT(*) n FROM produtos');
  assert.equal(n.n, 1);
  const base = { ean: '7891000000017', lote: 'L1', validade: mais(100), endereco: '3-A-1', operador: 'TESTE' };
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 4 });
  const tr = await S.leitura(db, { tipo: 'TRANSFERENCIA', lote_id: (await S.lotesAtivos(db))[0].id, qtd: 1, endereco_destino: '5-B-2', operador: 'TESTE' });
  assert.deepEqual(Object.fromEntries((await S.lotesAtivos(db)).map(x => [x.endereco, x.qtd])), { '3-A-1': 3, '5-B-2': 1 });
  await S.desfazer(db, tr.grupo);
  await assert.rejects(S.leitura(db, { ...base, tipo: 'BAIXA', qtd: 50, motivo: 'Venda' }), /saldo insuficiente/);
  assert.equal((await S.lotesAtivos(db))[0].qtd, 4);             // rollback do pg preservou o saldo
  await db.run('TRUNCATE produtos, lotes, eventos RESTART IDENTITY');
  const rel = await X.importar(db, await planilhaDeTeste());
  assert.equal(rel.lotes, 3);
  assert.equal((await S.resumo(db)).totais.lotes, 3);
});
