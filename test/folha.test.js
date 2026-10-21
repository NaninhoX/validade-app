const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const U = require('../lib/util');
const F = require('../lib/folha');
const OCR = require('../lib/ocr');
const R = require('../lib/folha-rotas');
const fx = require('./fixtures/folha-amostra.json');

let compartilhado;
async function novoDb() {
  if (!compartilhado) compartilhado = await open({ dir: 'memory://' });
  const db = compartilhado;
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  U.setAreas([19]);
  db.apagar = () => {};
  return db;
}
test.after(() => compartilhado && compartilhado.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };
const br = iso => iso.split('-').reverse().join('/');
const catalogoFx = new Map(Object.entries(fx.catalogo));

test('dígito verificador EAN-13', () => {
  assert.equal(F.eanValido('7896181297840'), true);
  assert.equal(F.eanValido('7896181210126'), false);
  assert.equal(F.eanValido('789618129784'), false);
  assert.equal(F.eanValido('78961812978AB'), false);
  assert.equal(F.digitoEan13('789618121012'), 2);
});

test('sugestões: troca de um dígito e troca de vizinhos, só no catálogo', () => {
  const c = F.candidatosEan('7896181210126');
  assert.ok(c.includes('7896181210122'));            // dígito verificador lido errado
  assert.ok(c.every(F.eanValido));
  // vizinhos trocados: 7896181297840 -> 7896181297804 é válido? só testamos que a transposição é gerada quando passa
  const t = F.candidatosEan('7896181279840');         // "97" lido como "79"
  assert.ok(t.includes('7896181297840'));
  assert.deepEqual(F.candidatosEan('abc'), []);
  assert.ok(F.candidatosEan('789618121012').includes('7896181210122'));   // faltou o último dígito
});

test('datas dd/mm/aa e dd/mm/aaaa viram ISO; datas impossíveis viram null', () => {
  assert.equal(F.dataISO('10/09/27'), '2027-09-10');
  assert.equal(F.dataISO('10/09/2027'), '2027-09-10');
  assert.equal(F.dataISO('1/2/27'), '2027-02-01');
  assert.equal(F.dataISO('100927'), '2027-09-10');
  assert.equal(F.dataISO('31/02/27'), null);
  assert.equal(F.dataISO('xx/09/27'), null);
  assert.equal(F.dataISO(''), null);
});

test('plausibilidade da validade: 1 ano atrás a 5 anos à frente', () => {
  const h = '2026-05-29';
  assert.equal(F.validadePlausivel('2027-09-10', h), null);
  assert.equal(F.validadePlausivel('2025-06-01', h), null);
  assert.match(F.validadePlausivel('2025-05-01', h), /1 ano no passado/);
  assert.equal(F.validadePlausivel('2031-05-29', h), null);
  assert.match(F.validadePlausivel('2031-06-01', h), /5 anos/);
});

test('lote e quantidade', () => {
  assert.equal(F.loteValido('0243'), true);
  assert.equal(F.loteValido('AB-12'), false);
  assert.equal(F.loteValido('1234567890123'), false);
  assert.equal(F.qtdValida('12'), 12);
  assert.equal(F.qtdValida(0), null);
  assert.equal(F.qtdValida(1000), null);
  assert.equal(F.qtdValida('1.5'), null);
  assert.equal(F.qtdValida(''), null);
});

test('fixture da folha: linhas boas ficam ok; EAN errado e repetida ficam duvidosas', () => {
  const r = F.validarLinhas(fx.linhas, { catalogo: catalogoFx, hoje: fx.hoje });
  assert.equal(r.length, 7);
  assert.deepEqual(r.map(x => x.status), ['ok', 'ok', 'ok', 'duvidosa', 'ok', 'ok', 'duvidosa']);
  const rep = r[3];
  assert.match(rep.motivos.join(' '), /repetida \(igual à linha 3\)/);
  assert.equal(rep.bloqueios.length, 0);                 // repetida não bloqueia: a pessoa confirma
  const ruim = r[6];
  assert.match(ruim.motivos[0], /dígito verificador/);
  assert.deepEqual(ruim.sugestoes, [{ ean: '7896181210122', nome: 'PRODUTO E' }]);
  assert.ok(ruim.bloqueios.length > 0);
  assert.equal(r[0].data_lancamento, '2026-05-29');
  assert.equal(r[0].validade, '2027-09-10');
  assert.equal(r[5].qtd, 12);
});

test('EAN válido fora do catálogo e dados ilegíveis ficam duvidosos', () => {
  const [a, b] = F.validarLinhas([
    { ean: '7896181297840', lote: '12', validade: '10/09/27', qtd: 1 },
    { ean: '', lote: '', validade: '32/13/27', qtd: 'a' },
  ], { catalogo: new Map(), hoje: fx.hoje });
  assert.equal(a.status, 'duvidosa');
  assert.match(a.motivos[0], /não cadastrado/);
  assert.equal(a.bloqueios.length, 0);                   // dá para lançar informando o nome
  assert.equal(b.status, 'duvidosa');
  assert.ok(b.bloqueios.length >= 4);
});

test('OCR: sem chave devolve 503 em português; com http falso não toca na rede', async () => {
  const foto = 'data:image/jpeg;base64,/9j/4AAQ';
  await assert.rejects(OCR.criarExtrator({ chave: () => '' })(foto), e => e.status === 503 && /ANTHROPIC_API_KEY/.test(e.message));
  let chamada;
  const http = async (url, init) => {
    chamada = { url, init };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '```json\n{"linhas":[{"data_lancamento":"29/05/26","ean":"7896181297840","lote":"1130","validade":"16/07/26","qtd":1}]}\n```' }] }) };
  };
  const linhas = await OCR.criarExtrator({ http, chave: () => 'chave-de-teste' })(foto);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].lote, '1130');
  const corpo = JSON.parse(chamada.init.body);
  assert.equal(corpo.model, 'claude-sonnet-5-5');
  assert.equal(chamada.init.headers['x-api-key'], 'chave-de-teste');
  assert.equal(corpo.messages[0].content[0].source.media_type, 'image/jpeg');
  await assert.rejects(OCR.criarExtrator({ http: async () => ({ ok: false, status: 500 }), chave: () => 'k' })(foto), e => e.status === 502);
});

test('rota ler: valida a resposta do extrator; foto grande demais é recusada', async () => {
  const db = await novoDb();
  await S.upsertProduto(db, { ean: '7896181297840', nome: 'PRODUTO B', preco: 10 });
  R.setExtrator(async () => [{ data_lancamento: '', ean: '7896181297840', lote: '1130', validade: br(mais(200)), qtd: 1 }, { ean: '7896181297841', lote: '1', validade: br(mais(200)), qtd: 1 }]);
  try {
    const r = await R.ler({ db, body: { foto: 'data:image/jpeg;base64,/9j/4AAQ' } });
    assert.equal(r.ok, 1); assert.equal(r.duvidosas, 1);
    assert.equal(r.linhas[0].produto, 'PRODUTO B');
    const grande = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil(R.MAX_FOTO * 4 / 3) + 100);
    await assert.rejects(R.ler({ db, body: { foto: grande } }), e => e.status === 413 && /grande demais/.test(e.message));
    await assert.rejects(R.ler({ db, body: { foto: 'texto' } }), e => e.status === 400);
  } finally { R.setExtrator(); }
});

test('rota lançar: grava RECEBIMENTO sem endereço, com operador, aviso de validade mínima e idempotência', async () => {
  const db = await novoDb();
  await S.upsertProduto(db, { ean: '7896181297840', nome: 'PRODUTO B', preco: 10 });
  await S.upsertProduto(db, { ean: '7908248300773', nome: 'PRODUTO A', preco: 10 });
  const body = {
    envio: 'abc',
    linhas: [
      { data_lancamento: '29/05/26', ean: '7896181297840', lote: '1130', validade: br(mais(20)), qtd: 2 },
      { ean: '7908248300773', lote: '0243', validade: br(mais(400)), qtd: 1 },
      { ean: '7896181210126', lote: '0928', validade: br(mais(400)), qtd: 1 },   // dígito inválido: não grava
    ],
  };
  const r = await R.lancar({ db, body, operador: 'MARIA' });
  assert.equal(r.lancadas, 2);
  assert.equal(r.falhas.length, 1);
  assert.equal(r.falhas[0].n, 3);
  assert.ok(r.avisos.some(a => /Linha 1: .*mínimo da loja/.test(a)));
  const ev = await db.all("SELECT tipo, ean, lote, endereco, delta, operador, obs FROM eventos ORDER BY id");
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].tipo, ev[0].endereco, ev[0].delta, ev[0].operador], ['RECEBIMENTO', '', 2, 'MARIA']);
  assert.match(ev[0].obs, /Folha FIFO de 29\/05\/2026/);
  assert.equal((await db.get("SELECT qtd FROM lotes WHERE ean='7896181297840'")).qtd, 2);
  // reenviar o mesmo envio não soma de novo
  const r2 = await R.lancar({ db, body, operador: 'MARIA' });
  assert.equal(r2.lancadas, 0);
  assert.equal((await db.get("SELECT qtd FROM lotes WHERE ean='7896181297840'")).qtd, 2);
});

test('rota lançar: endereço padrão digitado vai em todas as linhas; endereço inválido é recusado; EAN novo exige nome', async () => {
  const db = await novoDb();
  await S.upsertProduto(db, { ean: '7896181297840', nome: 'PRODUTO B', preco: 10 });
  const l = { ean: '7896181297840', lote: '1130', validade: br(mais(300)), qtd: 1 };
  await assert.rejects(R.lancar({ db, body: { endereco: 'XX', linhas: [l] }, operador: 'A' }), e => e.status === 400);
  await assert.rejects(R.lancar({ db, body: { linhas: [] }, operador: 'A' }), e => e.status === 400);
  const r = await R.lancar({ db, body: { endereco: '3-a-1', linhas: [l] }, operador: 'A' });
  assert.equal(r.lancadas, 1);
  assert.equal((await db.get('SELECT endereco FROM lotes')).endereco, '3-A-1');
  const novo = { ean: '7908248300773', lote: '9', validade: br(mais(300)), qtd: 1 };
  const semNome = await R.lancar({ db, body: { linhas: [novo] }, operador: 'A' });
  assert.equal(semNome.lancadas, 0);
  assert.match(semNome.falhas[0].erro, /informe o nome/);
  const comNome = await R.lancar({ db, body: { linhas: [{ ...novo, nome: 'PRODUTO NOVO' }] }, operador: 'A' });
  assert.equal(comNome.lancadas, 1);
});
