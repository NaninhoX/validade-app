const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const U = require('../lib/util');
const CF = require('../lib/conferencias');

let compartilhado;
async function novoDb() {
  if (!compartilhado) compartilhado = await open({ dir: 'memory://' });
  const db = compartilhado;
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config, conferencias, conferencia_itens, conferencia_ops RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20, categoria: 'RAÇÃO' });
  await S.upsertProduto(db, { ean: '7891000000024', nome: 'brinquedo bola', preco: 10, categoria: 'ACESSÓRIO' });
  await S.upsertProduto(db, { ean: '7891000000031', nome: 'Ácido Zeta', preco: 5 });
  await S.upsertProduto(db, { ean: '7891000000048', nome: 'ZEBRA', preco: 5 });
  U.setAreas([19]);
  return db;
}
test.after(() => compartilhado && compartilhado.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };
const EAN = '7891000000017', EAN2 = '7891000000024', EAN3 = '7891000000031', EAN4 = '7891000000048';

test('ciclo da sessão: abre, lê, edita, remove, fecha e fica imutável', async () => {
  const db = await novoDb();
  const c = await CF.abrir(db, { tipo: 'recebimento', operador: 'ANA', nota: ' 12345 ' });
  assert.equal(c.tipo, 'RECEBIMENTO');
  assert.equal(c.nota, '12345');
  assert.equal(c.aberta, true);
  await assert.rejects(() => CF.fechar(db, c.id), /Nenhum item/);
  await CF.adicionarItem(db, c.id, { client_id: 'a1', ean: EAN, qtd: 1 }, 'ANA');
  await CF.adicionarItem(db, c.id, { client_id: 'a2', ean: EAN, qtd: 1 }, 'ANA');
  const r = await CF.adicionarItem(db, c.id, { client_id: 'a3', ean: EAN, qtd: 10 }, 'ANA');
  assert.equal(r.item.qtd, 12);
  assert.equal(r.conferencia.linhas, 1);
  const b = await CF.adicionarItem(db, c.id, { client_id: 'b1', ean: EAN2 }, 'ANA');
  assert.equal(b.item.qtd, 1);
  await CF.editarItem(db, c.id, 'b1', { qtd: 6 }, 'ANA');           // edita por client_id
  await CF.removerItem(db, c.id, b.item.id);                        // remove por id
  const d = await CF.detalhe(db, c.id);
  assert.deepEqual(d.itens.map(i => [i.ean, i.qtd]), [[EAN, 12]]);
  assert.equal(d.conferencia.itens, 12);
  const f = await CF.fechar(db, c.id);
  assert.equal(f.aberta, false);
  assert.ok(f.fechada_em);
  assert.equal((await CF.fechar(db, c.id)).fechada_em, f.fechada_em);   // fechar de novo não muda nada
  for (const fn of [
    () => CF.adicionarItem(db, c.id, { client_id: 'a9', ean: EAN }, 'ANA'),
    () => CF.editarItem(db, c.id, 'a1', { qtd: 99 }, 'ANA'),
    () => CF.removerItem(db, c.id, 'a1'),
    () => CF.atualizar(db, c.id, { nota: 'x' }),
    () => CF.apagar(db, c.id),
  ]) await assert.rejects(fn, e => e.status === 409);
  assert.equal((await CF.detalhe(db, c.id)).itens[0].qtd, 12);        // nada mudou
  await assert.rejects(() => CF.abrir(db, { tipo: 'RONDA', operador: 'ANA' }), /tipo deve ser/);
});

test('idempotência por client_id: reenvio da fila offline não soma de novo', async () => {
  const db = await novoDb();
  const c = await CF.abrir(db, { tipo: 'CONTAGEM', operador: 'ANA', client_id: 'sessao-1', endereco: '3-a-1' });
  assert.equal((await CF.abrir(db, { tipo: 'CONTAGEM', operador: 'ANA', client_id: 'sessao-1' })).id, c.id);
  assert.equal(c.endereco, '3-A-1');
  await CF.adicionarItem(db, c.id, { client_id: 'x1', ean: EAN, qtd: 1 }, 'ANA');
  await CF.adicionarItem(db, c.id, { client_id: 'x2', ean: EAN, qtd: 1 }, 'ANA');
  const rep = await CF.adicionarItem(db, c.id, { client_id: 'x1', ean: EAN, qtd: 1 }, 'ANA');   // x1 chegou de novo
  assert.equal(rep.duplicado, true);
  await CF.adicionarItem(db, c.id, { client_id: 'x2', ean: EAN, qtd: 1 }, 'ANA');
  assert.equal((await CF.detalhe(db, c.id)).itens[0].qtd, 2);
  // x1 era o item que abriu a linha; remover e reenviar x1 não recria a linha
  await CF.removerItem(db, c.id, 'x1');
  await CF.adicionarItem(db, c.id, { client_id: 'x1', ean: EAN, qtd: 1 }, 'ANA');
  assert.equal((await CF.detalhe(db, c.id)).itens.length, 0);
  assert.equal((await db.all('SELECT * FROM eventos')).length, 0);    // contagem não mexe no estoque
});

test('EAN desconhecido pede o nome uma vez; depois fica cadastrado', async () => {
  const db = await novoDb();
  const c = await CF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'ANA' });
  await assert.rejects(() => CF.adicionarItem(db, c.id, { client_id: 'n1', ean: '7891000000055' }, 'ANA'), e => e.status === 422);
  const r = await CF.adicionarItem(db, c.id, { client_id: 'n1', ean: '7891000000055', nome: 'Produto Novo' }, 'ANA');
  assert.equal(r.item.nome, 'Produto Novo');
  const r2 = await CF.adicionarItem(db, c.id, { client_id: 'n2', ean: '7891000000055' }, 'ANA');
  assert.equal(r2.item.qtd, 2);
});

test('VALIDADE só corrige: a quantidade bipada vira o saldo do lote e nunca cria estoque sem confirmar', async () => {
  const db = await novoDb();
  const val = mais(120), br = val.split('-').reverse().join('/');
  const antes = await S.leitura(db, { tipo: 'RECEBIMENTO', ean: EAN, lote: 'L1', validade: val, endereco: '3-A-1', qtd: 10, operador: 'ANA' });
  const nL = async () => (await S.lotesAtivos(db)).filter(l => l.ean === EAN).map(l => [l.lote, l.qtd, l.endereco]).sort();
  const c = await CF.abrir(db, { tipo: 'VALIDADE', operador: 'BIA', endereco: '3-A-1' });

  // lote igual: a quantidade bipada vira o saldo (10 -> 1, depois 6), sem somar com o que o app tinha
  let r = await CF.adicionarItem(db, c.id, { client_id: 'v1', ean: EAN, lote: 'l1', validade: br }, 'BIA');
  assert.deepEqual(r.estoque, { acao: 'ajustado', antes: 10, depois: 1 });
  r = await CF.adicionarItem(db, c.id, { client_id: 'v2', ean: EAN, lote: 'L1', validade: val, qtd: 5 }, 'BIA');
  assert.deepEqual(await nL(), [['L1', 6, '3-A-1']]);
  await CF.adicionarItem(db, c.id, { client_id: 'v2', ean: EAN, lote: 'L1', validade: val, qtd: 5 }, 'BIA');          // reenvio: nada muda
  assert.deepEqual(await nL(), [['L1', 6, '3-A-1']]);
  r = await CF.adicionarItem(db, c.id, { client_id: 'v5', ean: EAN, lote: 'L1', validade: val, qtd: 4 }, 'BIA');      // 6 + 4 = 10 lidos: confere com o que o app tinha
  assert.deepEqual(r.estoque, { acao: 'ajustado', antes: 6, depois: 10 });

  // outro lote ou outra validade no mesmo endereço: pergunta (409) e não lança nada
  const sem = () => CF.adicionarItem(db, c.id, { client_id: 'v3', ean: EAN, lote: 'L2', validade: mais(200) }, 'BIA');
  await assert.rejects(sem, e => e.status === 409 && e.dados.pergunta === 'lote_diferente' && e.dados.candidatos[0].lote === 'L1' && e.dados.candidatos[0].qtd === 10);
  assert.deepEqual(await nL(), [['L1', 10, '3-A-1']]);
  // é um lote novo (confirmado)
  r = await CF.adicionarItem(db, c.id, { client_id: 'v3', ean: EAN, lote: 'L2', validade: mais(200), modo: 'novo' }, 'BIA');
  assert.equal(r.estoque.acao, 'novo');
  assert.deepEqual(await nL(), [['L1', 10, '3-A-1'], ['L2', 1, '3-A-1']]);
  // é o mesmo lote com a validade corrigida: o antigo zera e o saldo vai para o corrigido
  const l1 = (await S.lotesAtivos(db)).find(l => l.lote === 'L1');
  r = await CF.adicionarItem(db, c.id, { client_id: 'v6', ean: EAN, lote: 'L1', validade: mais(150), qtd: 8, modo: 'corrigir', lote_id: l1.id }, 'BIA');
  assert.equal(r.estoque.acao, 'corrigido');
  assert.deepEqual(await nL(), [['L1', 8, '3-A-1'], ['L2', 1, '3-A-1']]);
  assert.equal((await S.lotesAtivos(db)).filter(l => l.validade === val).length, 0);
  // produto que não estava no endereço: pergunta antes de criar
  await assert.rejects(() => CF.adicionarItem(db, c.id, { client_id: 'v7', ean: EAN2, lote: 'Z', validade: val }, 'BIA'), e => e.status === 409 && e.dados.pergunta === 'novo_lote');
  await assert.rejects(() => CF.adicionarItem(db, c.id, { client_id: 'v4', ean: EAN, lote: 'L3', validade: 'xx' }, 'BIA'), /validade inválida/);

  // corrigir a linha estorna e lança de novo; remover estorna tudo (volta ao que o app tinha)
  await CF.editarItem(db, c.id, 'v3', { qtd: 4 }, 'BIA');
  assert.deepEqual(await nL(), [['L1', 8, '3-A-1'], ['L2', 4, '3-A-1']]);
  await CF.removerItem(db, c.id, 'v3');
  assert.deepEqual(await nL(), [['L1', 8, '3-A-1']]);
  await CF.removerItem(db, c.id, 'v6');
  assert.deepEqual(await nL(), [['L1', 10, '3-A-1']]);
  await CF.removerItem(db, c.id, 'v1');
  assert.deepEqual(await nL(), [['L1', 10, '3-A-1']]);                                // tudo estornado: o app volta ao que tinha
  assert.ok(antes.grupo);
  // sem endereço também entra, depois de confirmar
  const c2 = await CF.abrir(db, { tipo: 'VALIDADE', operador: 'ANA' });
  await assert.rejects(() => CF.adicionarItem(db, c2.id, { client_id: 'w0', ean: EAN2, lote: '', validade: val }, 'ANA'), e => e.status === 409);
  await CF.adicionarItem(db, c2.id, { client_id: 'w1', ean: EAN2, lote: '', validade: val, modo: 'novo' }, 'ANA');
  assert.equal((await CF.detalhe(db, c2.id)).itens[0].lote, 'S/L');
});

test('RECEBIMENTO e CONTAGEM só registram: o estoque não muda', async () => {
  const db = await novoDb();
  await S.leitura(db, { tipo: 'RECEBIMENTO', ean: EAN, lote: 'L1', validade: mais(100), endereco: '3-A-1', qtd: 7, operador: 'ANA' });
  const antes = JSON.stringify(await S.lotesAtivos(db));
  const eventos = (await db.all('SELECT id FROM eventos')).length;
  for (const tipo of ['RECEBIMENTO', 'CONTAGEM']) {
    const c = await CF.abrir(db, { tipo, operador: 'ANA', endereco: '3-A-1' });
    await CF.adicionarItem(db, c.id, { client_id: 'e-' + tipo, ean: EAN, qtd: 50, lote: 'IGNORADO', validade: mais(5) }, 'ANA');
    const it = (await CF.detalhe(db, c.id)).itens[0];
    assert.equal(it.qtd, 50);
    assert.equal(it.lote, null);                                     // lote e validade só valem em VALIDADE
    assert.equal(it.validade, null);
    await CF.removerItem(db, c.id, it.id);
  }
  assert.equal(JSON.stringify(await S.lotesAtivos(db)), antes);
  assert.equal((await db.all('SELECT id FROM eventos')).length, eventos);
  await assert.rejects(() => CF.abrir(db, { tipo: 'CONTAGEM', operador: 'ANA', endereco: '4-E-1' }), /fora do padrão/);
});

test('ordem alfabética (acento e caixa ignorados) na lista e no CSV, com BOM e ponto e vírgula', async () => {
  const db = await novoDb();
  const c = await CF.abrir(db, { tipo: 'CONTAGEM', operador: 'ANA' });
  // ordem de leitura propositalmente bagunçada
  for (const [i, e] of [EAN4, EAN2, EAN, EAN3].entries()) await CF.adicionarItem(db, c.id, { client_id: 'o' + i, ean: e, qtd: i + 1, endereco: i % 2 ? '3-A-1' : '' }, 'ANA');
  const nomes = (await CF.detalhe(db, c.id)).itens.map(i => i.nome);
  assert.deepEqual(nomes, ['Ácido Zeta', 'brinquedo bola', 'RAÇÃO SECA TESTE 1KG', 'ZEBRA']);
  assert.deepEqual([...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })), nomes);
  const { __raw } = await CF.csv(db, c.id);
  assert.match(__raw.headers['Content-Type'], /text\/csv/);
  assert.equal(__raw.body[0], 0xEF);                                 // BOM UTF-8
  const linhas = __raw.body.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(linhas[0], 'EAN;Produto;Qtd;Lote;Validade;Endereço');
  assert.deepEqual(linhas.slice(1).map(l => l.split(';')[1]), nomes);
  assert.equal(linhas[1], `${EAN3};Ácido Zeta;4;;;3-A-1`);
  // mesmo produto: lote e depois validade
  const v = await CF.abrir(db, { tipo: 'VALIDADE', operador: 'ANA' });
  await CF.adicionarItem(db, v.id, { client_id: 'p1', ean: EAN, lote: 'B', validade: mais(100), modo: 'novo' }, 'ANA');
  await CF.adicionarItem(db, v.id, { client_id: 'p2', ean: EAN, lote: 'A', validade: mais(200), modo: 'novo' }, 'ANA');
  await CF.adicionarItem(db, v.id, { client_id: 'p3', ean: EAN, lote: 'A', validade: mais(100), modo: 'novo' }, 'ANA');
  assert.deepEqual((await CF.detalhe(db, v.id)).itens.map(i => [i.lote, i.validade]), [['A', mais(100)], ['A', mais(200)], ['B', mais(100)]]);
});

test('listagem com filtros de tipo, operador e data', async () => {
  const db = await novoDb();
  const a = await CF.abrir(db, { tipo: 'CONTAGEM', operador: 'ANA' });
  await CF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'BIA' });
  await CF.adicionarItem(db, a.id, { client_id: 'l1', ean: EAN, qtd: 3 }, 'ANA');
  await CF.adicionarItem(db, a.id, { client_id: 'l2', ean: EAN2, qtd: 2 }, 'ANA');
  const todas = await CF.listar(db, {});
  assert.equal(todas.length, 2);
  const [ana] = await CF.listar(db, { operador: 'ana' });
  assert.deepEqual([ana.id, ana.itens, ana.eans, ana.linhas], [a.id, 5, 2, 2]);
  assert.equal((await CF.listar(db, { tipo: 'recebimento' })).length, 1);
  assert.equal((await CF.listar(db, { data: U.hojeISO() })).length, 2);
  assert.equal((await CF.listar(db, { data: '2020-01-01' })).length, 0);
  assert.equal((await CF.listar(db, { de: '2020-01-01', ate: U.hojeISO() })).length, 2);
});

test('RONDA: resumo criado ao encerrar o turno é idempotente e aceita contagem que chega atrasada', async () => {
  const db = await novoDb();
  const inicio = Date.now() - 600000;
  const lote = async (ean, end, qtd, lot = 'L1') => (await S.leitura(db, { tipo: 'RECEBIMENTO', ean, lote: lot, validade: mais(100), endereco: end, qtd, operador: 'ANA' })).lote;
  const l1 = await lote(EAN, '3-A-1', 5), l2 = await lote(EAN2, '3-A-2', 4);
  // contagem de outro operador e contagem fora da janela não entram
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l2.id, qtd: 4, motivo: 'Ronda: confere', operador: 'BIA' });
  const fora = new Date(inicio - 3600000).toISOString();
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l2.id, qtd: 4, motivo: 'Ronda: confere', operador: 'ANA', ts: fora });
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l1.id, qtd: 3, motivo: 'Ronda: corrigido', operador: 'ANA', ts: new Date(inicio + 1000).toISOString() });
  const fim = Date.now();
  const entrada = { operador: 'ANA', client_id: 'turno-' + inicio, inicio, fim, feitos: 1, total: 2 };
  const r = await CF.registrarRonda(db, entrada);
  assert.equal(r.conferencia.tipo, 'RONDA');
  assert.equal(r.conferencia.aberta, false);
  assert.equal(r.conferencia.obs, '1 de 2 endereços');
  assert.deepEqual(r.itens.map(i => [i.ean, i.qtd, i.esperado, i.endereco]), [[EAN, 3, 5, '3-A-1']]);
  // reenvio do mesmo turno: mesma sessão, sem duplicar nada
  const r2 = await CF.registrarRonda(db, entrada);
  assert.equal(r2.conferencia.id, r.conferencia.id);
  assert.equal(r2.itens.length, 1);
  assert.equal((await CF.listar(db, { tipo: 'RONDA' })).length, 1);
  // a contagem do outro endereço chega depois pela fila offline: o resumo se completa sozinho
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l2.id, qtd: 4, motivo: 'Ronda: confere', operador: 'ANA', ts: new Date(inicio + 5000).toISOString() });
  const depois = await CF.detalhe(db, r.conferencia.id);
  assert.deepEqual(depois.itens.map(i => i.ean), [EAN2, EAN].sort((a, b) => (a === EAN2 ? -1 : 1)));   // brinquedo antes de ração
  assert.equal(depois.conferencia.linhas, 2);
  // somente leitura
  await assert.rejects(() => CF.adicionarItem(db, r.conferencia.id, { client_id: 'z', ean: EAN }, 'ANA'), e => e.status === 409);
  await assert.rejects(() => CF.removerItem(db, r.conferencia.id, depois.itens[0].id), e => e.status === 409);
  await assert.rejects(() => CF.registrarRonda(db, { operador: 'ANA', inicio: 'x', fim: 'y' }), e => e.status === 400);
  // cartão Hoje
  const h = await CF.hoje(db);
  assert.equal(h.rondas, 1);
  assert.equal(h.conferencias, 0);
});

test('cartão Hoje conta conferências fechadas e auditorias do dia', async () => {
  const db = await novoDb();
  const c = await CF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'ANA' });
  assert.deepEqual(await CF.hoje(db), { dia: U.hojeISO(), rondas: 0, conferencias: 0, abertas: 1, auditorias: 0, a_processar: 0 });
  await CF.adicionarItem(db, c.id, { client_id: 'h1', ean: EAN }, 'ANA');
  await CF.fechar(db, c.id);
  const l = (await S.leitura(db, { tipo: 'RECEBIMENTO', ean: EAN, lote: 'L1', validade: mais(100), endereco: '3-A-1', qtd: 2, operador: 'ANA' })).lote;
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l.id, qtd: 2, motivo: 'Auditoria: confere', operador: 'BIA' });
  const h = await CF.hoje(db);
  assert.deepEqual([h.conferencias, h.abertas, h.auditorias, h.a_processar], [1, 0, 1, 1]);
});
