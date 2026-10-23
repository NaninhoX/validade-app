const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const U = require('../lib/util');
const I = require('../lib/importador');
const NFE = require('../lib/nfe');
const CONF = require('../lib/conferencias');
const DEMO = require('../lib/demo');

let db;
async function novoDb() {
  if (!db) db = await open({ dir: 'memory://' });
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  await db.run('TRUNCATE conferencias, conferencia_itens, conferencia_ops RESTART IDENTITY');
  U.setAreas([19]);
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RACAO TESTE', preco: 20 });
  await S.upsertProduto(db, { ean: '7891000000024', nome: 'BOLA', preco: 10 });
  return db;
}
test.after(() => db && db.close());
const b64 = txt => ({ nome: 'x', base64: Buffer.from(txt, 'utf8').toString('base64') });

test('gtinValido confere o dígito verificador', () => {
  assert.equal(I.gtinValido('7891000000014'), true);
  assert.equal(I.gtinValido('7891000000017'), false);
  assert.equal(I.gtinValido('123'), false);
});

test('cabeçalho com nomes variados, ponto e vírgula e acentos', async () => {
  await novoDb();
  const csv = 'Código de Barras;Descrição;Qtde;Lote;Vencimento\n7891000000017;RACAO TESTE;12;L9;15/03/2027\n7891000000024;BOLA;3;;\n';
  const r = await I.analisar(db, [{ ...b64(csv), nome: 'lista.csv' }]);
  assert.deepEqual(r.resumo.arquivos[0].colunas.sort(), ['ean', 'lote', 'nome', 'qtd', 'validade']);
  assert.equal(r.resumo.total, 2);
  assert.deepEqual([r.linhas[0].ean, r.linhas[0].qtd, r.linhas[0].lote, r.linhas[0].validade, r.linhas[0].cadastrado], ['7891000000017', 12, 'L9', '2027-03-15', true]);
  assert.equal(r.resumo.com_erro, 0);
});

test('TXT sem cabeçalho: EAN e quantidade, separado por espaço ou vírgula', async () => {
  await novoDb();
  for (const txt of ['7891000000017 5\n7891000000024 2\n', '7891000000017,5\n7891000000024,2\n']) {
    const r = await I.analisar(db, [{ ...b64(txt), nome: 'contagem.txt' }]);
    assert.equal(r.resumo.arquivos[0].sem_cabecalho, true);
    assert.deepEqual(r.linhas.map(l => [l.ean, l.qtd]), [['7891000000017', 5], ['7891000000024', 2]]);
  }
});

test('linhas com problema são marcadas, não derrubam o arquivo', async () => {
  await novoDb();
  const csv = 'EAN;Quantidade;Validade\n7891000000017;abc;\n;4;\nSó código 123;1;\n7891000000024;2;99/99/9999\n7899999999990;1;\n';
  const r = await I.analisar(db, [{ ...b64(csv), nome: 'a.csv' }]);
  assert.equal(r.resumo.total, 5);
  assert.match(r.linhas[0].erros.join(), /quantidade inválida/);
  assert.match(r.linhas[1].erros.join(), /sem EAN/);
  assert.match(r.linhas[2].erros.join(), /parece código interno/);
  assert.match(r.linhas[3].erros.join(), /validade inválida/);
  assert.equal(r.linhas[4].cadastrado, false);               // EAN desconhecido: não é erro, só não cadastrado
  assert.equal(r.resumo.nao_cadastrados, 1);
});

test('arquivo sem EAN nem quantidade dá mensagem clara', async () => {
  await novoDb();
  await assert.rejects(I.analisar(db, [{ ...b64('foo;bar\n1;2\n'), nome: 'z.csv' }]), /não achei as colunas/);
});

const XML = `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35210112345678000195550010000012341000012343" versao="4.00">
<ide><nNF>1234</nNF><serie>1</serie><dhEmi>2026-10-20T10:00:00-03:00</dhEmi><natOp>VENDA</natOp></ide>
<emit><xNome>FABRICA PET LTDA</xNome><CNPJ>12345678000195</CNPJ></emit><dest><xNome>LOJA AP52</xNome><CNPJ>11222333000181</CNPJ></dest>
<det nItem="1"><prod><cProd>001</cProd><cEAN>7891000000017</cEAN><xProd>RACAO &amp; TESTE 1KG</xProd><uCom>CX</uCom><qCom>10.0000</qCom></prod></det>
<det nItem="2"><prod><cProd>002</cProd><cEAN>SEM GTIN</cEAN><cEANTrib>7891000000024</cEANTrib><xProd>BOLA</xProd><qCom>4.0000</qCom>
<rastro><nLote>A1</nLote><qLote>3.000</qLote><dVal>2027-05-10</dVal></rastro><rastro><nLote>A2</nLote><qLote>1.000</qLote><dVal>2027-08-01</dVal></rastro></prod></det>
<total><ICMSTot><vNF>1500.50</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;

test('NF-e: cabeçalho, itens, EAN tributável e lotes do rastro', () => {
  const nf = NFE.parseNFe(XML);
  assert.deepEqual([nf.numero, nf.serie, nf.emissao, nf.emitente, nf.valor], ['1234', '1', '2026-10-20', 'FABRICA PET LTDA', 1500.5]);
  assert.equal(nf.itens.length, 3);
  assert.deepEqual([nf.itens[0].ean, nf.itens[0].nome, nf.itens[0].qtd], ['7891000000017', 'RACAO & TESTE 1KG', 10]);
  assert.deepEqual(nf.itens.slice(1).map(i => [i.ean, i.qtd, i.lote, i.validade]), [['7891000000024', 3, 'A1', '2027-05-10'], ['7891000000024', 1, 'A2', '2027-08-01']]);
  assert.throws(() => NFE.parseNFe('<html></html>'), /não parece/);
});

test('chave de acesso: dígito verificador e partes', () => {
  const base = '3521011234567800019555001000001234100001234';
  const c = base + NFE.dvChave(base);
  assert.equal(NFE.chaveValida(c), true);
  const p = NFE.parseChave(c);
  assert.deepEqual([p.valida, p.numero, p.serie, p.cnpj], [true, '1234', '1', '12345678000195']);
  assert.equal(NFE.parseChave(c.slice(0, 43) + ((+c[43] + 1) % 10)).valida, false);
  assert.equal(NFE.parseChave('123').valida, false);
});

test('XML da nota entra no importador e as linhas vêm somadas por EAN ao carregar o esperado', async () => {
  await novoDb();
  const r = await I.analisar(db, [{ nome: 'nota.xml', base64: Buffer.from(XML).toString('base64') }]);
  assert.equal(r.resumo.arquivos[0].formato, 'xml');
  assert.equal(r.resumo.arquivos[0].nota.numero, '1234');
  const c = await CONF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'T' });
  const e = await CONF.carregarEsperado(db, c.id, { linhas: r.linhas, nota: r.resumo.arquivos[0].nota.numero });
  assert.deepEqual([e.criados, e.total, e.conferencia.nota], [2, 2, '1234']);      // 0024 vem em dois lotes: soma 4
  const lista = (await CONF.detalhe(db, c.id)).itens;
  assert.deepEqual(lista.map(i => [i.ean, i.qtd, i.esperado]).sort(), [['7891000000017', 0, 10], ['7891000000024', 0, 4]]);
  // contar: a linha existente ganha a quantidade, o esperado fica
  await CONF.adicionarItem(db, c.id, { ean: '7891000000017', qtd: 10 }, 'T');
  await CONF.adicionarItem(db, c.id, { ean: '7891000000024', qtd: 5 }, 'T');
  const dep = (await CONF.detalhe(db, c.id)).itens.map(i => [i.ean, i.qtd, i.esperado]).sort();
  assert.deepEqual(dep, [['7891000000017', 10, 10], ['7891000000024', 5, 4]]);     // igual (verde) e a mais (vermelho)
  // recarregar substitui o esperado em vez de duplicar
  const e2 = await CONF.carregarEsperado(db, c.id, { linhas: [{ ean: '7891000000017', qtd: 12 }] });
  assert.deepEqual([e2.criados, e2.atualizados], [0, 1]);
});

test('lista esperada só em Recebimento e Contagem, e só com conferência aberta', async () => {
  await novoDb();
  const v = await CONF.abrir(db, { tipo: 'VALIDADE', operador: 'T' });
  await assert.rejects(CONF.carregarEsperado(db, v.id, { linhas: [{ ean: '7891000000017', qtd: 1 }] }), /só vale para Recebimento e Contagem/);
  const c = await CONF.abrir(db, { tipo: 'CONTAGEM', operador: 'T' });
  await assert.rejects(CONF.carregarEsperado(db, c.id, { linhas: [{ ean: 'x', qtd: 1 }] }), /nenhuma linha válida/);
  await CONF.carregarEsperado(db, c.id, { linhas: [{ ean: '7891000000017', qtd: 2 }] });
  await CONF.fechar(db, c.id);
  await assert.rejects(CONF.carregarEsperado(db, c.id, { linhas: [{ ean: '7891000000017', qtd: 2 }] }), /já foi fechada/);
});

test('demonstração: carrega uma vez, só em banco sem estoque, e tem EANs válidos', async () => {
  await novoDb();
  await db.run('TRUNCATE produtos, lotes, eventos RESTART IDENTITY');
  assert.equal(DEMO.ean13('789100000001').length, 13);
  assert.equal(I.gtinValido(DEMO.ean13('789100000001')), true);
  const r = await DEMO.semearUmaVez(db);
  assert.ok(r.lotes > 20);
  assert.equal((await DEMO.semearUmaVez(db)).pulado, true);
  assert.ok((await S.lotesAtivos(db)).some(l => l.dias <= 0));       // tem vencidos para mostrar
  await db.run('TRUNCATE produtos, lotes, eventos, config RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'X' });
  await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000017', lote: 'A', validade: '2030-01-01', endereco: '1-A-1', qtd: 1, operador: 'T' });
  assert.equal((await DEMO.semearUmaVez(db)).pulado, true);          // estoque real: não mistura
});

test('TXT para o sistema da loja: linha em branco e EAN;quantidade, somando lotes do mesmo EAN', async () => {
  await novoDb();
  const v = await CONF.abrir(db, { tipo: 'VALIDADE', operador: 'T', endereco: '3-A-1' });
  await CONF.adicionarItem(db, v.id, { ean: '7891000000017', qtd: 2, lote: 'A', validade: '2030-01-01' }, 'T');
  await CONF.adicionarItem(db, v.id, { ean: '7891000000017', qtd: 3, lote: 'B', validade: '2030-02-01' }, 'T');
  await CONF.adicionarItem(db, v.id, { ean: '7891000000024', qtd: 1, lote: 'C', validade: '2030-03-01' }, 'T');
  const r = await CONF.txtLoja(db, v.id);
  const linhas = r.__raw.body.toString('utf8').split('\r\n');
  assert.equal(linhas[0], ' ');
  assert.deepEqual(linhas.slice(1, 3), ['7891000000024;1', '7891000000017;5']);          // BOLA antes de RACAO (alfabética)
  assert.match(r.__raw.headers['Content-Disposition'], /\.txt"/);
  // o que o app exporta, o importador entende de volta
  const volta = await I.analisar(db, [{ nome: 'x.txt', base64: r.__raw.body.toString('base64') }]);
  assert.deepEqual(volta.linhas.map(l => [l.ean, l.qtd]), [['7891000000024', 1], ['7891000000017', 5]]);
});

test('Finalizada e Processada: só processa depois de fechar, e processar de novo não muda', async () => {
  await novoDb();
  const c = await CONF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'T' });
  await CONF.adicionarItem(db, c.id, { ean: '7891000000017', qtd: 2 }, 'T');
  await assert.rejects(CONF.processar(db, c.id, 'ANA'), /Finalize a conferência/);
  assert.equal((await CONF.hoje(db)).a_processar, 0);
  await CONF.fechar(db, c.id);
  assert.equal((await CONF.hoje(db)).a_processar, 1);
  const p = await CONF.processar(db, c.id, 'ANA');
  assert.deepEqual([p.processada, db && p.processada_por], [true, 'ANA']);
  const p2 = await CONF.processar(db, c.id, 'BIA');
  assert.equal(p2.processada_por, 'ANA');
  assert.equal((await CONF.hoje(db)).a_processar, 0);
});

test('lista de avaria e RMA: situação Vencido ou Avariado, validade só dos vencidos, soma por lote e causa', async () => {
  await novoDb();
  const RMA = require('../lib/rma');
  const mais = d => U.hojeISO(new Date(Date.now() + d * 864e5));
  const a = (await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000017', lote: 'V', validade: mais(-3), endereco: '1-A-1', qtd: 6, operador: 'T' })).lote;
  const b = (await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000024', lote: 'B', validade: mais(200), endereco: '1-A-2', qtd: 4, operador: 'T' })).lote;
  await S.leitura(db, { tipo: 'BAIXA', lote_id: a.id, qtd: 2, motivo: 'RMA', causa: 'Giro baixo', operador: 'T' });
  await S.leitura(db, { tipo: 'BAIXA', lote_id: a.id, qtd: 3, motivo: 'RMA', causa: 'Giro baixo', operador: 'T' });
  await S.leitura(db, { tipo: 'BAIXA', lote_id: b.id, qtd: 1, motivo: 'Avaria', causa: 'Ficou escondido ou mal exposto', operador: 'T' });
  await S.leitura(db, { tipo: 'BAIXA', lote_id: b.id, qtd: 1, motivo: 'Venda', operador: 'T' });        // venda não entra
  const r = await RMA.lista(db, {});
  assert.deepEqual(r.itens.map(i => [i.nome, i.lote, i.situacao, i.qtd, i.validade ? 1 : 0, i.causa]),
    [['BOLA', 'B', 'Avariado', 1, 0, 'Avaria: Ficou escondido ou mal exposto'], ['RACAO TESTE', 'V', 'Vencido', 5, 1, 'RMA: Giro baixo']]);
  assert.deepEqual([r.totais.vencidos, r.totais.avariados, r.totais.qtd], [1, 1, 6]);
  const csv = (await RMA.csv(db, {})).__raw.body.toString('utf8');
  assert.ok(csv.startsWith('﻿Produto;EAN;Lote;Situação'));
  await assert.rejects(RMA.lista(db, { de: '2020-01-01', ate: '2026-12-31' }), /período grande/);
});

test('conferência feita offline guarda o horário real do aparelho ao abrir e ao fechar', async () => {
  await novoDb();
  const ha = m => new Date(Date.now() - m * 60000).toISOString();
  const c = await CONF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'T', client_id: 'off-1', ts: ha(90) });
  assert.equal(c.aberta_em, ha(90).slice(0, 16) === c.aberta_em.slice(0, 16) ? c.aberta_em : null);
  assert.ok(Math.abs(Date.parse(c.aberta_em) - (Date.now() - 90 * 60000)) < 2000);
  await CONF.adicionarItem(db, c.id, { ean: '7891000000017', qtd: 2, client_id: 'i-off' }, 'T');
  const f = await CONF.fechar(db, c.id, ha(30));
  assert.ok(Math.abs(Date.parse(f.fechada_em) - (Date.now() - 30 * 60000)) < 2000);
  assert.equal(f.minutos, 60);
  // horário no futuro ou antes da abertura não vale
  const c2 = await CONF.abrir(db, { tipo: 'CONTAGEM', operador: 'T', client_id: 'off-2', ts: new Date(Date.now() + 3600e3).toISOString() });
  assert.ok(Date.parse(c2.aberta_em) <= Date.now() + 1000);
  await CONF.adicionarItem(db, c2.id, { ean: '7891000000017', qtd: 1, client_id: 'i-off2' }, 'T');
  const f2 = await CONF.fechar(db, c2.id, ha(500));
  assert.ok(Date.parse(f2.fechada_em) >= Date.parse(f2.aberta_em));
  // reenviar a criação (rede caiu depois de criar) devolve a mesma conferência
  assert.equal((await CONF.abrir(db, { tipo: 'RECEBIMENTO', operador: 'T', client_id: 'off-1', ts: ha(90) })).id, c.id);
});

test('perda potencial evitada: unidades vendidas (baixa Venda) dentro da faixa de risco, com a regra de desconto do painel', async () => {
  await novoDb();
  const mais = d => U.hojeISO(new Date(Date.now() + d * 864e5));
  await S.upsertProduto(db, { ean: '7891000000031', nome: 'RAÇÃO DE TESTE', preco: 100, categoria: 'RAÇÃO' });
  await S.upsertProduto(db, { ean: '7891000000048', nome: 'BRINQUEDO', preco: 50, categoria: 'ACESSÓRIO' });
  const mk = async (ean, lote, d, qtd) => (await S.leitura(db, { tipo: 'RECEBIMENTO', ean, lote, validade: mais(d), endereco: '1-A-1', qtd, operador: 'T' })).lote;
  const racao20 = await mk('7891000000031', 'R1', 60, 10);        // ração a 60 dias: faixa de 90 dias, 20% de desconto
  const brinq10 = await mk('7891000000048', 'B1', 20, 10);        // não ração a 20 dias: faixa de 30 dias, 50%
  const longe = await mk('7891000000048', 'B2', 300, 10);         // longe do vencimento: não conta
  await S.leitura(db, { tipo: 'BAIXA', lote_id: racao20.id, qtd: 3, motivo: 'Venda', operador: 'T' });     // 3 × 100 × 20% = 60
  await S.leitura(db, { tipo: 'BAIXA', lote_id: brinq10.id, qtd: 2, motivo: 'Venda', operador: 'T' });     // 2 × 50 × 50% = 50
  await S.leitura(db, { tipo: 'BAIXA', lote_id: longe.id, qtd: 4, motivo: 'Venda', operador: 'T' });
  await S.leitura(db, { tipo: 'BAIXA', lote_id: brinq10.id, qtd: 1, motivo: 'Avaria', causa: 'Outro', operador: 'T' });   // não é venda
  const r = await S.evitada(db, { dias: 30 });
  assert.equal(r.evitada, 110);
  assert.deepEqual([r.unidades, r.unidades_risco, r.vendido_em_risco], [9, 5, 400]);
  assert.equal(r.por_faixa.length, 2);
  // venda desfeita deixa de contar
  const v = await S.leitura(db, { tipo: 'BAIXA', lote_id: racao20.id, qtd: 1, motivo: 'Venda', operador: 'T' });
  assert.equal((await S.evitada(db, {})).evitada, 130);
  await S.desfazer(db, v.grupo);
  assert.equal((await S.evitada(db, {})).evitada, 110);
  assert.equal((await S.resumo(db)).evitada.evitada, 110);       // o painel e o Modo TV leem do resumo
  // produto sem preço entra nas unidades, não no valor
  await S.upsertProduto(db, { ean: '7891000000055', nome: 'SEM PRECO' });
  const sp = await mk('7891000000055', 'S1', 10, 5);
  await S.leitura(db, { tipo: 'BAIXA', lote_id: sp.id, qtd: 2, motivo: 'Venda', operador: 'T' });
  const r2 = await S.evitada(db, {});
  assert.deepEqual([r2.evitada, r2.sem_preco_un], [110, 2]);
});

test('preço digitado aceita todos os formatos (antes só a letra "d" passava na tela)', async () => {
  const casos = { '39': 39, '39,90': 39.9, '39.90': 39.9, '1.299,90': 1299.9, '1,299.90': 1299.9, '1299,9': 1299.9, 'R$ 39,90': 39.9, '1.299': 1299, '0,999': 0.999, '12,5': 12.5, '1.299.990': 1299990, '0': 0 };
  for (const [txt, n] of Object.entries(casos)) assert.equal(U.parsePreco(txt), n, txt);
  assert.equal(U.parsePreco(''), null);
  for (const ruim of ['abc', '-5', '12,x', '1,2,3,x']) assert.ok(Number.isNaN(U.parsePreco(ruim)), ruim);
  await novoDb();
  await S.upsertProduto(db, { ean: '7891000000062', nome: 'NOVO', preco: '1.299,90' });
  assert.equal(Number((await S.getProduto(db, '7891000000062')).preco), 1299.9);
  await S.upsertProduto(db, { ean: '7891000000062', nome: 'NOVO', preco: 49 });
  assert.equal(Number((await S.getProduto(db, '7891000000062')).preco), 49);
  await assert.rejects(S.upsertProduto(db, { ean: '7891000000062', nome: 'NOVO', preco: 'abc' }), /preço inválido/);
});

test('perda potencial evitada é acumulada: conta lotes antigos marcados "✅ Vendido" (legado) e vendas de qualquer data, pelo prazo de hoje', async () => {
  await novoDb();
  const mais = d => U.hojeISO(new Date(Date.now() + d * 864e5));
  await S.upsertProduto(db, { ean: '7891000000079', nome: 'BRINQUEDO X', preco: 10, categoria: 'ACESSÓRIO' });
  // legado da planilha: lote já vencido marcado vendido (vale o valor inteiro), outro a 20 dias (50%), outro longe (nada)
  const mk = async (lote, d, qtd) => (await S.leitura(db, { tipo: 'RECEBIMENTO', ean: '7891000000079', lote, validade: mais(d), endereco: '1-A-1', qtd, operador: 'T' })).lote;
  const v1 = await mk('V1', -10, 4), v2 = await mk('V2', 20, 4), v3 = await mk('V3', 300, 4);
  for (const l of [v1, v2, v3]) await db.run("UPDATE lotes SET acao='✅ Vendido' WHERE id=?", [l.id]);
  const r = await S.evitada(db, {});
  assert.deepEqual([r.legado.lotes, r.legado.unidades, r.legado.evitada], [3, 12, 40 + 20]);      // 4×10×100% + 4×10×50%
  assert.equal(r.evitada, 60);
  // depois de baixar o lote legado como Venda histórica, não conta duas vezes
  await db.run("UPDATE lotes SET acao=NULL WHERE id IN (?,?,?)", [v1.id, v2.id, v3.id]);
  await db.run("INSERT INTO eventos(ts,tipo,lote_id,ean,lote,validade,endereco,delta,operador,motivo,historico) VALUES(?,?,?,?,?,?,?,?,?,?,1)", [mais(-60) + 'T12:00:00.000Z', 'BAIXA', v1.id, '7891000000079', 'V1', mais(-10), '1-A-1', -4, 'T', 'Venda']);
  await db.run('UPDATE lotes SET qtd=0 WHERE id=?', [v1.id]);
  const r2 = await S.evitada(db, {});
  assert.equal(r2.legado.lotes, 0);
  assert.equal(r2.evitada, 40);                                                                  // venda histórica do lote que já venceu: valor inteiro
  assert.deepEqual([r2.ultimos.evitada, r2.ultimos.unidades], [0, 0]);                           // fora dos últimos 30 dias
});
