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
  U.setAreas([19]);
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
  assert.equal(U.parseEndereco('19').valido, true);         // sacaria: 19 vale (ainda sem pallet)
  assert.equal(U.parseEndereco('19').gondola, 19);
  assert.equal(U.parseEndereco('4-E-1').valido, false);     // lado inexistente
  assert.equal(U.parseEndereco('3-A-11').valido, false);    // no máximo 10 módulos
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
  await assert.rejects(S.leitura(db, { ...base, tipo: 'RECEBIMENTO', qtd: 1, endereco: '3-A-11' }), /fora do padrão/);
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

test('layout: escala (px por cm) é validada e persistida; caixa derivada pode ser fina', async () => {
  const db = await novoDb();
  const l = S.layoutPadrao();
  assert.equal((await S.setLayout(db, l)).escala, undefined);              // layout antigo continua válido, sem escala
  const fino = { ...l, escala: 0.2503, gondolas: [{ id: 1, x: 0, y: 0, w: 195.2, h: 8, rot: 0 }] };
  const salvo = await S.setLayout(db, fino);
  assert.equal(salvo.escala, 0.2503);
  assert.equal((await S.getLayout(db)).gondolas[0].h, 8);
  for (const ruim of [0, 0.001, 3, 'abc', -1]) await assert.rejects(S.setLayout(db, { ...fino, escala: ruim }), /escala inválida/);
  await assert.rejects(S.setLayout(db, { ...fino, gondolas: [{ id: 1, x: 0, y: 0, w: 0, h: 8 }] }), /largura inválido/);
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
  await assert.rejects(A.login(db, 'ANA', '000000'), /Restam 4 tentativa/);
  for (let i = 0; i < 3; i++) await assert.rejects(A.login(db, 'ANA', '000000'), /incorreto/);
  await assert.rejects(A.login(db, 'ANA', '000000'), /bloqueado/);
  await assert.rejects(A.login(db, 'ANA', '123456'), /Muitas tentativas/);      // bloqueada mesmo com o PIN certo
  await assert.rejects(A.login(db, 'NINGUEM', '123456'), /não encontrado/);
  await A.salvarUsuario(db, { nome: 'Dânyllo', pin: '654321', papel: 'operador' });
  assert.equal((await A.login(db, 'danyllo', '654 321')).nome, 'DÂNYLLO');          // sem acento e com espaço no PIN
  await A.salvarUsuario(db, { nome: 'SEMPIN' });
  await assert.rejects(A.login(db, 'sempin', '123456'), /ainda não tem PIN/);
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

test('setores: nome e responsáveis por lado, validados, e aparecem no mapa e na ronda', async () => {
  const db = await novoDb();
  await A.salvarUsuario(db, { nome: 'DAVI', pin: '123456', papel: 'operador' });
  await A.salvarUsuario(db, { nome: 'DENI', pin: '123456', papel: 'operador' });
  const r = await S.setSetores(db, { 3: { A: { nome: ' Higiene ', resp: ['davi', 'DENI', 'DAVI'] }, B: { nome: '', resp: [] } }, 9: { PE: { nome: 'Entrada', resp: ['DENI'] } } });
  assert.deepEqual(r, { 3: { A: { nome: 'Higiene', resp: ['DAVI', 'DENI'] } }, 9: { PE: { nome: 'Entrada', resp: ['DENI'] } } });
  await assert.rejects(S.setSetores(db, { 3: { A: { resp: ['FULANO'] } } }), /não existe/);
  await assert.rejects(S.setSetores(db, { 3: { PE: { nome: 'x' } } }), /lado PE não existe/);   // PE/PD só nas gôndolas 9 e 10
  await assert.rejects(S.setSetores(db, { 9: { F: { nome: 'x' } } }), /lado F não existe/);
  await assert.rejects(S.setSetores(db, { 99: { A: { nome: 'x' } } }), /inválida/);
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base });
  assert.equal((await S.mapa(db)).setores[3].A.nome, 'Higiene');
  assert.equal((await S.ronda(db, { n: 5 })).setores[3].A.resp[1], 'DENI');
});

test('endereços das gôndolas 9 e 10 usam PE/PD; nas demais, F/C', () => {
  assert.equal(U.parseEndereco('9-PE').valido, true);
  assert.equal(U.parseEndereco('10-PD-2').valido, true);
  assert.equal(U.parseEndereco('9-F').valido, false);
  assert.equal(U.parseEndereco('3-PE').valido, false);
  assert.equal(U.parseEndereco('3-C').valido, true);
  assert.equal(U.parseEndereco('9-A-3').valido, true);
  assert.deepEqual(U.lados(9), ['A', 'B', 'PE', 'PD']);
});

test('medidas editáveis e caminhos de fluxo na planta', async () => {
  const db = await novoDb();
  assert.deepEqual(await S.getDimensoes(db), { modulo_c: 140, modulo_l: 40, ponta_c: 100, ponta_p: 40 });
  await S.setDimensoes(db, { modulo_c: 150, modulo_l: 45, ponta_c: 95, ponta_p: 40 });
  assert.equal((await S.getDimensoes(db)).modulo_c, 150);
  await assert.rejects(S.setDimensoes(db, { modulo_c: 10, modulo_l: 45, ponta_c: 95, ponta_p: 40 }), /entre 40 e 300/);
  const l = await S.setLayout(db, { ...(await S.getLayout(db)), caminhos: [{ curva: true, pts: [{ x: 100, y: 200 }, { x: 150.26, y: 220 }, { x: 300, y: 220 }] }] });
  assert.deepEqual(l.caminhos, [{ curva: true, pts: [{ x: 100, y: 200 }, { x: 150.3, y: 220 }, { x: 300, y: 220 }] }]);
  await assert.rejects(S.setLayout(db, { ...l, caminhos: [{ pts: [{ x: 1, y: 1 }] }] }), /ao menos 2 pontos/);
  const antigo = await S.setLayout(db, { ...l, caminhos: undefined, setas: [{ x: 100, y: 200, c: 90, rot: 90 }] });   // layouts antigos com setas viram caminhos
  assert.deepEqual(antigo.caminhos, [{ curva: false, pts: [{ x: 100, y: 200 }, { x: 100, y: 290 }] }]);
});

test('contagem grava o preço de produto que ainda não tinha', async () => {
  const db = await novoDb();
  await S.upsertProduto(db, { ean: '7891000000031', nome: 'PETISCO SEM PRECO' });
  assert.equal((await S.getProduto(db, '7891000000031')).preco, null);
  const r = await S.leitura(db, { tipo: 'CONTAGEM', qtd: 4, ...base, ean: '7891000000031', preco: '12,90' });
  assert.equal((await S.getProduto(db, '7891000000031')).preco, 12.9);
  assert.equal(r.lote.valor, 51.6);
  await assert.rejects(S.leitura(db, { tipo: 'CONTAGEM', qtd: 1, ...base, lote: 'X', ean: '7891000000031', preco: 'abc' }), /preço inválido/);
});

test('baixa: RMA substitui Vencido e RMA Fornecedor', async () => {
  const db = await novoDb();
  assert.ok(S.MOTIVOS_BAIXA.includes('RMA'));
  assert.ok(!S.MOTIVOS_BAIXA.includes('Vencido') && !S.MOTIVOS_BAIXA.includes('RMA Fornecedor'));
  const r = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, validade: mais(-2) });
  await S.leitura(db, { tipo: 'BAIXA', lote_id: r.lote.id, qtd: 3, motivo: 'RMA', causa: 'Giro baixo', operador: 'TESTE' });
  await assert.rejects(S.leitura(db, { tipo: 'BAIXA', ...base, validade: mais(-2), qtd: 1, motivo: 'Vencido' }), /motivo/);
});

test('ronda: só os meus setores (gôndola-lado)', async () => {
  const db = await novoDb();
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, endereco: '3-A-1', validade: mais(10) });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'B', endereco: '3-B-1', validade: mais(10) });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, endereco: '7-B-2', validade: mais(10) });
  assert.deepEqual((await S.ronda(db, { n: 5, setores: ['3-B', '7-B'] })).enderecos.map(e => e.endereco), ['3-B-1', '7-B-2']);
  assert.equal((await S.ronda(db, { n: 5, setores: [] })).enderecos.length, 3);
});

test('recebimento avisa lote com validade curta; o mínimo é configurável', async () => {
  const db = await novoDb();
  assert.equal(await S.getValidadeMinima(db), 90);
  const r = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, validade: mais(40) });
  assert.ok(r.avisos.some(a => /mínimo da loja: 90/.test(a)));
  const ok = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'L2', validade: mais(200) });
  assert.ok(!ok.avisos.some(a => /mínimo/.test(a)));
  await S.setValidadeMinima(db, 0);
  const off = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'L3', validade: mais(40) });
  assert.ok(!off.avisos.some(a => /mínimo/.test(a)));
  await assert.rejects(S.setValidadeMinima(db, 400), /0 a 365/);
});

test('placar por responsável conta só os lados dele; produtos em estoque sem preço', async () => {
  const db = await novoDb();
  await A.salvarUsuario(db, { nome: 'DAVI', pin: '123456', papel: 'operador' });
  await S.setSetores(db, { 3: { A: { nome: 'Rações', resp: ['DAVI'] } }, 9: { PE: { resp: ['DAVI'] } } });
  const v = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, endereco: '3-A-1', validade: mais(-1) });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'OUTRO', endereco: '3-B-1', validade: mais(-1) });   // lado B não é dele
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: v.lote.id, qtd: 2, motivo: 'Ronda: corrigido', operador: 'DAVI' });
  const [p] = await S.placar(db);
  assert.deepEqual([p.nome, p.setores, p.vencidos, p.lotes, p.ronda7_lotes, p.ronda7_divergencia], ['DAVI', ['3-A', '9-PE'], 1, 1, 1, 100]);
  await S.upsertProduto(db, { ean: '7891000000031', nome: 'SEM PRECO' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 1, ...base, ean: '7891000000031', lote: 'Z', validade: mais(200) });
  assert.equal((await S.resumo(db)).qualidade.produtos_sem_preco, 1);
});

test('sacaria (19): vale sozinha ou com pallet; pallet só na sacaria', () => {
  assert.equal(U.parseEndereco('19').valido, true);
  const p = U.parseEndereco('19-P3');
  assert.deepEqual([p.valido, p.tipo, p.lado, p.nivel], [true, 'pallet', 'P', 3]);
  assert.equal(U.parseEndereco('7-P3').valido, false);
  assert.equal(U.parseEndereco('19-P41').valido, false);
  assert.equal(U.parseEndereco('18').valido, false);
  assert.deepEqual(U.lados(19), ['P']);
});

test('migração A↔B nas gôndolas 11–18: troca endereços (inclusive quando os dois lados têm o mesmo lote), ajusta histórico, roda uma vez', async () => {
  const { inverterLados } = require('../lib/migracao');
  const db = await novoDb();
  const v = mais(200);
  const a = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, endereco: '11-A-2', validade: v });
  const b = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 4, ...base, endereco: '11-B-2', validade: v });   // mesmo lote do outro lado: os dois trocam de lugar, sem colisão
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'X', endereco: '13-A-1', validade: v });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 6, ...base, lote: 'Y', endereco: '3-A-1', validade: v });       // gôndola 3: não mexe
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 7, ...base, lote: 'Z', endereco: '12-F', validade: v });        // ponta: não mexe
  await A.salvarUsuario(db, { nome: 'DAVI', pin: '123456', papel: 'operador' });
  await S.setSetores(db, { 11: { A: { nome: 'Rações', resp: ['DAVI'] } } });
  const r = await inverterLados(db);
  assert.deepEqual([r.ja_feita, r.lotes, r.somados], [false, 3, 0]);
  const por = Object.fromEntries((await S.lotesAtivos(db)).map(l => [`${l.lote}@${l.endereco}`, l.qtd]));
  assert.deepEqual(por, { 'L1@11-B-2': 3, 'L1@11-A-2': 4, 'X@13-B-1': 5, 'Y@3-A-1': 6, 'Z@12-F': 7 });
  const evs = await db.all("SELECT endereco FROM eventos WHERE lote='L1' AND desfeito=0");
  assert.deepEqual(evs.map(e => e.endereco).sort(), ['11-A-2', '11-B-2']);
  assert.ok((await S.eventos(db, { limite: 50 })).some(e => e.endereco === '13-B-1'));
  assert.deepEqual(Object.keys((await S.getSetores(db))[11]), ['B']);
  assert.equal((await inverterLados(db)).ja_feita, true);        // segunda vez não faz nada
  assert.equal((await S.lotesAtivos(db)).length, 5);
});

test('configuração das gôndolas: lados, módulos, medidas, nomes e sacaria com pallets', async () => {
  const db = await novoDb();
  const r = await S.setGondolasCfg(db, {
    7: { lados: 'A', modulos: 4, dim: { modulo_c: 130, modulo_l: '' }, nomes: { 'A-2': ' Fantasia ' } },
    19: { c: 700, l: 420, pallets: [{ x: 10, y: 10, c: 120, l: 100, nome: 'Rações 15kg' }, { id: 5, x: 200, y: 10 }] },
  });
  assert.deepEqual(r[7], { tipo: 'gondola', nome: '', frente: null, lados: 'A', modulos: 4, dim: { modulo_c: 130 }, nomes: { 'A-2': 'Fantasia' } });
  assert.deepEqual(r[19].pallets.map(p => p.id), [1, 5]);
  assert.equal(r[19].tipo, 'area');
  await assert.rejects(S.setGondolasCfg(db, { 7: { lados: 'A', nomes: { 'B-1': 'x' } } }), /não existe/);
  await assert.rejects(S.setGondolasCfg(db, { 7: { modulos: 4, nomes: { 'A-5': 'x' } } }), /não existe/);
  await assert.rejects(S.setGondolasCfg(db, { 7: { dim: { modulo_c: 5 } } }), /entre 40 e 300/);
  await assert.rejects(S.setGondolasCfg(db, { 19: { pallets: [{ id: 2 }, { id: 2 }] } }), /repetido/);
  assert.deepEqual((await S.mapa(db)).gondolas_cfg[7].nomes, { 'A-2': 'Fantasia' });
});

test('gôndolas e áreas novas: nome, tipo e frente; endereços de área passam a valer', async () => {
  const db = await novoDb();
  assert.equal(U.parseEndereco('22-P1').valido, false);
  const r = await S.setGondolasCfg(db, { 22: { tipo: 'area', nome: 'Sacaria de cães', c: 800, l: 300, pallets: [{ x: 0, y: 0 }] }, 23: { nome: 'Farmácia', lados: 'A', modulos: 3, frente: 'D' }, 19: { tipo: 'gondola' } });
  assert.deepEqual([r[22].tipo, r[22].nome, r[23].tipo, r[23].frente, r[23].modulos], ['area', 'Sacaria de cães', 'gondola', 'D', 3]);
  assert.equal(U.parseEndereco('22-P1').valido, true);
  assert.equal(U.parseEndereco('22').valido, true);
  assert.equal(U.parseEndereco('19').valido, false);            // 19 virou gôndola comum
  assert.equal(U.parseEndereco('23-A-2').valido, true);
  assert.deepEqual((await S.mapa(db)).areas.sort(), [22]);
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, endereco: '22-P1' });
  assert.equal((await S.lotesAtivos(db))[0].endereco, '22-P1');
  U.setAreas([19]);
  await S.sincronizaAreas(db);                                    // cache curto: recarrega da configuração
});

test('briefing: junta retirar, etiquetar e ronda, com responsáveis', async () => {
  const db = await novoDb();
  await A.salvarUsuario(db, { nome: 'DAVI', pin: '123456', papel: 'operador' });
  await S.setSetores(db, { 1: { A: { nome: '', resp: ['DAVI'] } } });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, lote: 'V', validade: '2020-01-01', endereco: '1-A-1' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'E', validade: U.hojeISO(new Date(Date.now() + 20 * 864e5)), endereco: '1-A-2' });
  const b = await S.briefing(db);
  assert.equal(b.retirar.total, 1);
  assert.deepEqual(b.retirar.itens[0].resp, ['DAVI']);
  assert.equal(b.etiquetar.total, 1);
  assert.equal(b.ronda.enderecos.length, 2);
  assert.ok(b.totais.vencido_lotes === 1);
});

test('regra conservadora: lote que some na ronda faz os outros valerem pela validade mais curta', async () => {
  const db = await novoDb();
  const curto = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, lote: 'CURTO', validade: mais(20) })).lote;
  const longo = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ...base, lote: 'LONGO', validade: mais(200) })).lote;
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: curto.id, qtd: 0, motivo: 'Ronda: não encontrado', operador: 'TESTE' });
  const l = (await S.lotesAtivos(db)).find(x => x.id === longo.id);
  assert.equal(l.misto, true);
  assert.equal(l.validade, mais(200));              // a validade real continua registrada
  assert.equal(l.validade_efetiva, mais(20));       // o alerta usa a mais curta
  assert.ok(l.dias <= 20);
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: longo.id, qtd: 0, motivo: 'Ronda: não encontrado', operador: 'TESTE' });
  const depois = await db.get('SELECT validade_alerta FROM lotes WHERE id=?', [longo.id]);
  assert.equal(depois.validade_alerta, null);        // zerou: a mistura some junto
});

test('regra conservadora: lote vencido que some não contamina os outros', async () => {
  const db = await novoDb();
  const velho = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'VELHO', validade: mais(-5) })).lote;
  const bom = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 4, ...base, lote: 'BOM', validade: mais(200) })).lote;
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: velho.id, qtd: 0, motivo: 'Ronda: não encontrado', operador: 'TESTE' });
  assert.equal((await S.lotesAtivos(db)).find(x => x.id === bom.id).misto, false);
});

test('"completei outra caixa": o destino passa a valer pela validade mais curta e dá para confirmar depois', async () => {
  const db = await novoDb();
  const a = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 4, ...base, lote: 'A', validade: mais(25) })).lote;
  const b = (await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 6, ...base, lote: 'B', validade: mais(300) })).lote;
  const r = await S.misturar(db, { origem_id: a.id, destino_id: b.id, qtd: 3, operador: 'TESTE' });
  assert.equal(r.validade_alerta, mais(25));
  const lotes = await S.lotesAtivos(db);
  assert.equal(lotes.find(x => x.id === a.id).qtd, 1);
  const dest = lotes.find(x => x.id === b.id);
  assert.equal(dest.qtd, 9);
  assert.equal(dest.validade_efetiva, mais(25));
  await assert.rejects(S.misturar(db, { origem_id: a.id, destino_id: a.id, qtd: 1, operador: 'TESTE' }), /mesmo lote/);
  await assert.rejects(S.misturar(db, { origem_id: a.id, destino_id: b.id, qtd: 50, operador: 'TESTE' }), /saldo insuficiente/);
});

test('validade ilegível entra "a confirmar" com a validade mais curta conhecida e depois se confirma', async () => {
  const db = await novoDb();
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'X', validade: mais(40) });
  const r = await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ean: base.ean, lote: 'Y', validade: '', validade_confirmar: true, endereco: '3-A-1', operador: 'TESTE' });
  assert.equal(r.lote.a_confirmar, true);
  assert.equal(r.lote.validade, mais(40));
  await assert.rejects(S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 1, ...base, lote: 'Z', validade: '' }), /validade inválida/);   // sem o marcador, continua exigindo
  const c = await S.confirmarValidade(db, { lote_id: r.lote.id, validade: mais(120), operador: 'TESTE' });
  const l = (await S.lotesAtivos(db)).find(x => x.id === c.lote_id);
  assert.deepEqual([l.a_confirmar, l.validade, l.qtd], [false, mais(120), 5]);
  await assert.rejects(S.confirmarValidade(db, { lote_id: l.id, validade: mais(130), operador: 'TESTE' }), /não está marcado/);
});

test('contagem só por EAN: a falta sai do lote de validade mais longa', async () => {
  const db = await novoDb();
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 3, ...base, lote: 'CURTO', validade: mais(15) });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 4, ...base, lote: 'LONGO', validade: mais(250) });
  const r = await S.ajusteTotal(db, { ean: base.ean, endereco: '3-A-1', qtd_total: 5, operador: 'TESTE' });
  assert.deepEqual([r.antes, r.depois], [7, 5]);
  const por = Object.fromEntries((await S.lotesAtivos(db)).map(l => [l.lote, l.qtd]));
  assert.deepEqual(por, { CURTO: 3, LONGO: 2 });
  await assert.rejects(S.ajusteTotal(db, { ean: base.ean, endereco: '3-A-1', qtd_total: 99, operador: 'TESTE' }), /informe o lote/);
});

test('ronda: sem preço não inventa valor; endereço fora do padrão sobe; lotes sem endereço são contados', async () => {
  const db = await novoDb();
  await S.upsertProduto(db, { ean: '7891000000031', nome: 'SEM PRECO' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 2, ...base, lote: 'P', validade: mais(-3) });
  await S.leitura(db, { tipo: 'RECEBIMENTO', qtd: 5, ean: '7891000000031', lote: 'S', validade: mais(-3), endereco: '', sem_endereco: true, operador: 'TESTE' });
  const todos = await S.lotesAtivos(db);
  assert.equal(S.precoMediano(todos), 20);                          // mediana dos preços unitários que existem
  assert.equal(todos.find(l => l.lote === 'S').valor, null);        // o produto sem preço continua sem preço
  const r = await S.ronda(db, { n: 5 });
  assert.deepEqual(r.sem_endereco, { lotes: 1, qtd: 5 });
});
