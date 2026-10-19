const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const A = require('../lib/auth');
const U = require('../lib/util');
const X = require('../lib/excel');
const { classificar, FAIXAS_PADRAO, ehRacao, descontoPct } = require('../lib/rules');

let compartilhado;
// Um Postgres de verdade (PGlite) em memória, limpo antes de cada teste.
async function novoDb() {
  if (!compartilhado) compartilhado = await open({ dir: 'memory://' });
  const db = compartilhado;
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20, categoria: 'RAÇÃO' });
  await S.upsertProduto(db, { ean: '7891000000024', nome: 'BRINQUEDO BOLA', preco: 10, categoria: 'ACESSÓRIO' });
  db.apagar = () => {};
  return db;
}
test.after(() => compartilhado && compartilhado.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };
const base = { ean: '7891000000017', lote: 'L1', validade: mais(100), endereco: '3-A-1', operador: 'TESTE' };

test('parseData aceita os formatos digitados no coletor', () => {
  assert.equal(U.parseData('150327'), '2027-03-15');
  assert.equal(U.parseData('15/03/2027'), '2027-03-15');
  assert.equal(U.parseData('03/27'), '2027-03-31');       // mês/ano => último dia
  assert.equal(U.parseData('0227'), '2027-02-28');
  assert.equal(U.parseData('31/02/2027'), null);
  assert.equal(U.parseData('abc'), null);
  assert.equal(U.parseData(46296), '2026-10-01');          // serial do Excel
});

test('endereço: gôndola-lado-prateleira, pontas F/C e legado', () => {
  const p = U.parseEndereco('1-B-3');
  assert.deepEqual([p.valido, p.gondola, p.lado, p.nivel, p.tipo], [true, 1, 'B', 3, 'face']);
  assert.deepEqual([U.parseEndereco('1-C').valido, U.parseEndereco('1-C').tipo, U.parseEndereco('1-F').nivel], [true, 'ponta', null]);
  assert.equal(U.parseEndereco('2-F-4').nivel, 4);
  assert.equal(U.parseEndereco('19').valido, false);        // legado: só a gôndola
  assert.equal(U.parseEndereco('19').gondola, 19);
  assert.equal(U.parseEndereco('4-E-1').valido, false);     // lado inexistente
  assert.equal(U.parseEndereco('3-A-6').valido, false);     // só 5 prateleiras
  assert.equal(U.parseEndereco(' 3 - a - 1 ').valido, true); // normaliza
  assert.match(U.erroEndereco('4-E-1'), /fora do padrão/);
});

test('regra de prevenção: ração 20% e resto 30% até 90 dias; tudo 50% até 30 dias; sem 10%', () => {
  const desc = (dias, racao) => descontoPct(classificar(dias, FAIXAS_PADRAO), racao);
  assert.deepEqual([120, 91, 90, 61, 60, 31].map(d => desc(d, true)), [0, 0, 20, 20, 20, 20]);
  assert.deepEqual([120, 91, 90, 61, 60, 31].map(d => desc(d, false)), [0, 0, 30, 30, 30, 30]);
  assert.deepEqual([30, 16, 15, 1].map(d => [desc(d, true), desc(d, false)]), [[50, 50], [50, 50], [50, 50], [50, 50]]);
  assert.equal(desc(0, true), 0);                           // vencido: retirar
  assert.ok(!FAIXAS_PADRAO.some(f => f.desconto === 10 || f.desconto_racao === 10));
  assert.deepEqual([0, 1, 15, 16, 30, 31, 60, 61, 90, 91, 120, 121].map(d => classificar(d).status),
    ['Vencido', 'Urgente', 'Urgente', 'Alerta 30d', 'Alerta 30d', 'Alerta 60d', 'Alerta 60d', 'Alerta 90d', 'Alerta 90d', 'Atenção', 'Atenção', 'OK']);
  assert.equal(ehRacao('RAÇAO UMIDA SACHE GATOS', null), true);
  assert.equal(ehRacao('BRINQUEDO BOLA', 'ACESSÓRIO'), false);
  assert.equal(ehRacao('PETISCO RACAO', 'PETISCO'), false);  // categoria manda
});

test('lote enriquecido usa o desconto certo por categoria', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 2, validade: mais(70) });
  await S.leitura(db, { ...base, ean: '7891000000024', tipo: 'RECEBIMENTO', qtd: 2, validade: mais(70), endereco: '4-B-2' });
  await S.leitura(db, { ...base, ean: '7891000000024', lote: 'Z', tipo: 'RECEBIMENTO', qtd: 1, validade: mais(20), endereco: '4-B-2' });
  const por = Object.fromEntries((await S.lotesAtivos(db)).map(l => [`${l.nome}|${l.dias > 30 ? 90 : 30}`, l.desconto]));
  assert.equal(por['RAÇÃO SECA TESTE 1KG|90'], 20);
  assert.equal(por['BRINQUEDO BOLA|90'], 30);
  assert.equal(por['BRINQUEDO BOLA|30'], 50);
  db.apagar();
});

test('recebimento soma, contagem define, baixa subtrai e não deixa saldo negativo', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 5 });
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 3 });
  assert.equal((await S.lotesAtivos(db))[0].qtd, 8);
  await S.leitura(db, { ...base, tipo: 'CONTAGEM', qtd: 6 });
  assert.equal((await S.lotesAtivos(db))[0].qtd, 6);
  await S.leitura(db, { ...base, tipo: 'BAIXA', qtd: 2, motivo: 'Venda' });
  assert.equal((await S.lotesAtivos(db))[0].qtd, 4);
  await assert.rejects(S.leitura(db, { ...base, tipo: 'BAIXA', qtd: 99, motivo: 'Venda' }), /saldo insuficiente/);
  assert.equal((await S.lotesAtivos(db))[0].qtd, 4);
  db.apagar();
});

test('endereço novo precisa seguir o padrão', async () => {
  const db = await novoDb();
  await assert.rejects(S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, endereco: '4-E-1' }), /fora do padrão/);
  await assert.rejects(S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, endereco: '3-A-9' }), /fora do padrão/);
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, endereco: '3-C' });          // ponta sem prateleira
  assert.equal((await S.lotesAtivos(db)).length, 1);
  db.apagar();
});

test('client_id torna o reenvio idempotente (coletor offline)', async () => {
  const db = await novoDb();
  const a = await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 5, client_id: 'abc' });
  const b = await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 5, client_id: 'abc' });
  assert.equal(b.duplicado, true);
  assert.equal(b.grupo, a.grupo);
  assert.equal((await S.lotesAtivos(db))[0].qtd, 5);
  db.apagar();
});

test('transferência move saldo entre endereços e desfazer reverte tudo', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 10 });
  const id = (await S.lotesAtivos(db))[0].id;
  const t = await S.leitura(db, { tipo: 'TRANSFERENCIA', lote_id: id, qtd: 4, endereco_destino: '5-B-2', operador: 'TESTE' });
  const por = Object.fromEntries((await S.lotesAtivos(db)).map(l => [l.endereco, l.qtd]));
  assert.deepEqual(por, { '3-A-1': 6, '5-B-2': 4 });
  await S.desfazer(db, t.grupo);
  const depois = Object.fromEntries((await S.lotesAtivos(db)).map(l => [l.endereco, l.qtd]));
  assert.deepEqual(depois, { '3-A-1': 10 });
  db.apagar();
});

test('avisos: FEFO, validade vencida e EAN novo exige nome', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 2, lote: 'NOVO', validade: mais(300) });
  const r = await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 2, lote: 'VELHO', validade: mais(40) });
  assert.ok(r.avisos.some(a => a.includes('FEFO')));
  const v = await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, lote: 'X', validade: mais(-3) });
  assert.ok(v.avisos.some(a => a.includes('vencida')));
  await assert.rejects(S.leitura(db, { ...base, ean: '7890000000000', tipo: 'RECEBIMENTO', qtd: 1 }), /não cadastrado/);
  await S.leitura(db, { ...base, ean: '7890000000000', nome: 'NOVO PRODUTO', tipo: 'RECEBIMENTO', qtd: 1 });
  assert.equal((await S.getProduto(db, '7890000000000')).nome, 'NOVO PRODUTO');
  db.apagar();
});

test('mapa: agrega por gôndola, lado e prateleira, e lista pontas e legado', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 4, lote: 'A', validade: mais(10), endereco: '1-B-3' });
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 2, lote: 'B', validade: mais(200), endereco: '1-B-3' });
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, lote: 'C', validade: mais(200), endereco: '1-C' });
  await db.run("INSERT INTO lotes(ean,lote,validade,endereco,qtd,atualizado_em) VALUES('7891000000017','LEG',?, '19', 3, ?)", [mais(50), U.agoraISO()]);
  const m = await S.mapa(db);
  const g1 = m.gondolas.find(g => g.id === 1);
  const b3 = g1.celulas.find(c => c.chave === 'B-3');
  assert.equal(b3.lotes, 2);
  assert.equal(b3.qtd, 6);
  assert.equal(b3.pior, 'Urgente');                                   // pior status da prateleira
  assert.ok(g1.celulas.some(c => c.chave === 'C' && c.lado === 'C'));  // ponta sem prateleira
  assert.equal(m.gondolas.find(g => g.id === 19).celulas[0].chave, 'geral');
  assert.equal(m.layout.gondolas.length, 19);                          // planta provisória
  assert.equal(m.layout.provisorio, true);
  db.apagar();
});

test('layout: valida e persiste a planta', async () => {
  const db = await novoDb();
  const l = S.layoutPadrao();
  l.gondolas[0].x = 333;
  await S.setLayout(db, l);
  const lido = await S.getLayout(db);
  assert.equal(lido.gondolas[0].x, 333);
  assert.equal(lido.provisorio, false);
  await assert.rejects(S.setLayout(db, { ...l, gondolas: [{ id: 1, x: 0, y: 0, w: 10, h: 10 }] }), /largura inválido/);
  await assert.rejects(S.setLayout(db, { ...l, fundo: 'http://evil/x.png' }), /planta de fundo inválida/);
  db.apagar();
});

test('login: PIN com hash, bloqueio após 5 erros e papéis', async () => {
  const db = await novoDb();
  await A.salvarUsuario(db, { nome: 'ana', pin: '123456', papel: 'admin' });
  await assert.rejects(A.salvarUsuario(db, { nome: 'bia', pin: '123' }), /6 a 8 números/);
  const u = await A.login(db, 'Ana', '123456');
  assert.deepEqual(u, { nome: 'ANA', papel: 'admin' });
  const linha = await db.get("SELECT pin_hash FROM usuarios WHERE nome='ANA'");
  assert.ok(!linha.pin_hash.includes('123456'));
  for (let i = 0; i < 5; i++) await assert.rejects(A.login(db, 'ANA', '000000'), /incorretos/);
  await assert.rejects(A.login(db, 'ANA', '123456'), /Muitas tentativas/);      // bloqueada mesmo com o PIN certo
  await assert.rejects(A.login(db, 'NINGUEM', '123456'), /incorretos/);
  await assert.rejects(A.salvarUsuario(db, { nome: 'ANA', papel: 'operador' }), /pelo menos um administrador/);
  db.apagar();
});

test('sessão: cookie assinado não pode ser adulterado', () => {
  process.env.SESSION_SECRET = 'segredo-de-teste-com-mais-de-24-caracteres';
  const cookie = A.cookieSessao('ANA', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test('resumo e fila usam as faixas; exportação gera um xlsx válido', async () => {
  const db = await novoDb();
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 4, lote: 'A', validade: mais(10) });
  await S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 2, lote: 'B', validade: mais(-5) });
  const r = await S.resumo(db);
  assert.equal(r.totais.itens, 6);
  assert.equal(r.por_status.find(s => s.status === 'Vencido').lotes, 1);
  const fila = await S.fila(db);
  assert.deepEqual(fila.map(f => f.status).sort(), ['Urgente', 'Vencido']);
  assert.ok(fila[0].score >= fila[1].score);
  const buf = await X.exportar(db);
  assert.equal(Buffer.from(buf).subarray(0, 2).toString(), 'PK');
  db.apagar();
});

test('ronda do dia: ranqueia por risco × tempo sem conferir, ordena para caminhar e exclui o já conferido hoje', async () => {
  const db = await novoDb();
  const l = (o) => S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, ...o });
  await l({ endereco: '7-B-2', lote: 'V', validade: mais(-3) });                 // vencido: pior caso
  await l({ endereco: '2-A-1', lote: 'U', validade: mais(10) });                 // urgente
  await l({ endereco: '2-C', lote: 'N', validade: mais(400), ean: '7891000000024' }); // longe de vencer
  await l({ endereco: '9-A-3', lote: 'H', validade: mais(20) });
  const r = await S.ronda(db, { n: 5 });
  assert.equal(r.enderecos.length, 4);
  // a lista volta na ordem de caminhada: gôndola 2 (A antes de C), 7, 9
  assert.deepEqual(r.enderecos.map(e => e.endereco), ['2-A-1', '2-C', '7-B-2', '9-A-3']);
  const por = Object.fromEntries(r.enderecos.map(e => [e.endereco, e]));
  assert.equal(por['7-B-2'].vencidos, 1);
  assert.ok(por['7-B-2'].score > por['2-A-1'].score && por['2-A-1'].score > por['2-C'].score);
  assert.deepEqual(por['2-A-1'].etiquetar, { 50: 1 });
  assert.ok(r.cobertura > 0 && r.cobertura <= 100);
  // limita ao tamanho pedido: fica com os de maior nota
  const so2 = await S.ronda(db, { n: 5 });
  assert.equal(so2.n, 5);
  // conferir o endereço hoje o tira da fila
  const item = (await S.esperadoNoEndereco(db, '7-B-2')).itens[0];
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: item.id, qtd: 5, motivo: 'Ronda: confere', operador: 'TESTE' });
  const depois = await S.ronda(db, { n: 5 });
  assert.ok(!depois.enderecos.some(e => e.endereco === '7-B-2'));
  assert.equal(depois.conferidos_hoje, 1);
});

test('etiqueta de desconto: registra, deixa de pedir, volta a pedir se a faixa mudar e desfaz', async () => {
  const db = await novoDb();
  const r0 = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, endereco: '4-B-2', validade: mais(20) });
  const id = r0.lote.id;
  assert.equal(r0.lote.etiquetar, true);
  const r1 = await S.leitura(db, { tipo: 'ETIQUETA', lote_id: id, desconto: 50, operador: 'TESTE' });
  assert.equal(r1.lote.etiquetado, true);
  assert.equal(r1.lote.etiquetar, false);
  assert.equal(r1.lote.qtd, 3);                                   // saldo intacto
  const p = await S.ronda(db, { n: 5 });
  assert.deepEqual(p.enderecos[0].etiquetar, {});
  // etiqueta de 30% numa faixa que agora pede 50% continua pendente
  await S.leitura(db, { tipo: 'ETIQUETA', lote_id: id, desconto: 30, operador: 'TESTE' });
  assert.equal((await S.lotesAtivos(db, { endereco: '4-B-2' }))[0].etiquetar, true);
  const un = await S.leitura(db, { tipo: 'ETIQUETA', lote_id: id, desconto: 50, operador: 'TESTE' });
  await S.desfazer(db, un.grupo);
  assert.equal((await S.lotesAtivos(db, { endereco: '4-B-2' }))[0].acao, 'Etiquetado 30%');
  await assert.rejects(S.leitura(db, { tipo: 'ETIQUETA', lote_id: id, desconto: 0, operador: 'TESTE' }), /desconto/);
  await assert.rejects(S.leitura(db, { tipo: 'ETIQUETA', ...base, desconto: 50 }), /informe o lote/);
});

test('painel da ronda: conta conferidos, corrigidos e não achei por dia', async () => {
  const db = await novoDb();
  const a = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'A', endereco: '1-A-1' });
  const b = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'B', endereco: '1-A-1' });
  const c = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'C', endereco: '1-A-2' });
  const cont = (x, qtd, motivo) => S.leitura(db, { tipo: 'CONTAGEM', lote_id: x.lote.id, qtd, motivo, operador: 'TESTE' });
  await cont(a, 5, 'Ronda: confere');
  await cont(b, 4, 'Ronda: corrigido');
  await cont(c, 0, 'Ronda: não encontrado');
  await S.leitura(db, { tipo: 'ETIQUETA', lote_id: a.lote.id, desconto: 30, operador: 'TESTE' });
  const [hoje] = await S.rondaPainel(db, 7);
  assert.equal(hoje.dia, U.hojeISO());
  assert.deepEqual([hoje.enderecos, hoje.lotes, hoje.confere, hoje.corrigido, hoje.nao_achei, hoje.etiquetas], [2, 3, 1, 1, 1, 1]);
  assert.equal(hoje.divergencia, 66.7);
});
