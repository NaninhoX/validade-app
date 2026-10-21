const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const S = require('../lib/service');
const A = require('../lib/auth');
const U = require('../lib/util');
const AUD = require('../lib/auditoria');

let compartilhado;
async function novoDb() {
  if (!compartilhado) compartilhado = await open({ dir: 'memory://' });
  const db = compartilhado;
  await db.run('TRUNCATE produtos, lotes, eventos, usuarios, config RESTART IDENTITY');
  await S.upsertProduto(db, { ean: '7891000000017', nome: 'RAÇÃO SECA TESTE 1KG', preco: 20, categoria: 'RAÇÃO' });
  await S.upsertProduto(db, { ean: '7891000000024', nome: 'BRINQUEDO BOLA', preco: 10, categoria: 'ACESSÓRIO' });
  U.setAreas([19]);
  return db;
}
test.after(() => compartilhado && compartilhado.close());
const mais = d => { const x = new Date(); x.setDate(x.getDate() + d); return U.hojeISO(x); };
const EAN = '7891000000017', EAN2 = '7891000000024';

async function usuarios(db, ...nomes) { for (const nome of nomes) await A.salvarUsuario(db, { nome, pin: '123456', papel: 'operador' }); }
async function recebe(db, endereco, lote, qtd, operador = 'ANA', ean = EAN, validade = mais(100)) {
  return S.leitura(db, { tipo: 'CONTAGEM', ean, lote, validade, endereco, qtd, operador });
}
// 12 endereços com estoque, contados por ANA e BETO alternadamente
async function loja(db) {
  for (let i = 1; i <= 12; i++) await recebe(db, `${i}-A-1`, `L${i}`, 10 + i, i % 2 ? 'ANA' : 'BETO');
}

test('semana ISO: virada de ano', () => {
  assert.equal(AUD.semanaISO('2026-01-01'), '2026-W01');
  assert.equal(AUD.semanaISO('2024-12-30'), '2025-W01');
  assert.equal(AUD.semanaISO('2021-01-03'), '2020-W53');
  assert.equal(AUD.semanaISO('2026-10-21'), '2026-W43');
  assert.deepEqual(AUD.semanasAte(3, '2026-10-21'), ['2026-W41', '2026-W42', '2026-W43']);
});

test('sorteio é determinístico (semana + lista), independe da ordem e respeita n', () => {
  const cand = Array.from({ length: 30 }, (_, i) => ({ endereco: `${i + 1}-B-2`, exposicao: i * 3 }));
  const a = AUD.sortear({ semana: '2026-W43', candidatos: cand, n: 5 });
  const b = AUD.sortear({ semana: '2026-W43', candidatos: [...cand].reverse(), n: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  assert.equal(new Set(a).size, 5);
  assert.notDeepEqual(a, AUD.sortear({ semana: '2026-W44', candidatos: cand, n: 5 }));
  assert.equal(AUD.sortear({ semana: '2026-W43', candidatos: cand.slice(0, 3), n: 10 }).length, 3);
});

test('sorteio favorece alta exposição', () => {
  const cand = [{ endereco: 'ALTO', exposicao: 5000 }, ...Array.from({ length: 19 }, (_, i) => ({ endereco: `B${i}`, exposicao: 1 }))];
  let alto = 0;
  for (let s = 1; s <= 52; s++) if (AUD.sortear({ semana: `2026-W${String(s).padStart(2, '0')}`, candidatos: cand, n: 3 }).includes('ALTO')) alto++;
  assert.ok(alto >= 45, `ALTO sorteado em ${alto}/52 semanas`);
});

test('auditor é sempre diferente de quem contou por último; operador único é permitido e marcado', () => {
  const ends = ['1-A-1', '2-A-1', '3-A-1', '4-A-1'];
  const ultimo = { '1-A-1': 'ANA', '2-A-1': 'BETO', '3-A-1': 'ANA', '4-A-1': 'CARLA' };
  const r = AUD.atribuir({ semana: '2026-W43', enderecos: ends, ultimo, operadores: ['ANA', 'BETO'] });
  for (const i of r) { assert.notEqual(i.auditor, i.ultimo_contador); assert.equal(i.mesmo_operador, false); }
  const solo = AUD.atribuir({ semana: '2026-W43', enderecos: ends, ultimo, operadores: ['ANA'] });
  assert.equal(solo.find(i => i.endereco === '1-A-1').auditor, 'ANA');
  assert.equal(solo.find(i => i.endereco === '1-A-1').mesmo_operador, true);
  assert.equal(solo.find(i => i.endereco === '2-A-1').mesmo_operador, false);
  assert.deepEqual(AUD.atribuir({ semana: 'x', enderecos: ['1-A-1'], ultimo: {}, operadores: [] })[0].auditor, null);
});

test('plano da semana: fixo durante a semana, 5 por padrão, configurável de 3 a 10', async () => {
  const db = await novoDb(); await loja(db); await usuarios(db, 'ANA', 'BETO');
  const p1 = await AUD.planoDaSemana(db);
  assert.equal(p1.itens.length, 5);
  for (const i of p1.itens) assert.notEqual(i.auditor, i.ultimo_contador);
  await recebe(db, '20-A-1', 'NOVO', 9999);          // estoque novo no meio da semana não muda a lista
  assert.deepEqual((await AUD.planoDaSemana(db)).itens, p1.itens);
  await assert.rejects(AUD.setN(db, 2), /entre 3 e 10/);
  await assert.rejects(AUD.setN(db, 11), /entre 3 e 10/);
  await AUD.setN(db, 8);
  assert.equal(await AUD.getN(db), 8);
  assert.equal((await AUD.planoDaSemana(db)).itens.length, 5);           // a semana corrente já está fechada
  await db.run("DELETE FROM config WHERE chave LIKE 'auditoria_plano:%'");
  assert.equal((await AUD.planoDaSemana(db)).itens.length, 8);
});

test('payload cego nunca traz a quantidade do sistema', async () => {
  const db = await novoDb(); await usuarios(db, 'ANA', 'BETO');
  await recebe(db, '1-A-1', 'LA', 137); await recebe(db, '1-A-1', 'LB', 4242, 'ANA', EAN2);
  await AUD.setN(db, 3);
  const plano = await AUD.planoDaSemana(db);
  const item = plano.itens.find(i => i.endereco === '1-A-1');
  assert.ok(item, 'único endereço com estoque entra no plano');
  const c = await AUD.cego(db, { endereco: '1-A-1', operador: item.auditor });
  assert.equal(c.lotes.length, 2);
  const txt = JSON.stringify(c);
  assert.ok(!/qtd|quantidade|saldo|valor|preco|137|4242/i.test(txt), txt);
  for (const l of c.lotes) assert.deepEqual(Object.keys(l).sort(), ['ean', 'id', 'lote', 'marca', 'nome', 'validade']);
  // o plano da semana também não carrega quantidades de lotes pendentes
  const geral = JSON.stringify(await AUD.auditoria(db, { operador: item.auditor }));
  assert.ok(!/137|4242/.test(geral));
  await assert.rejects(AUD.cego(db, { endereco: '1-A-1', operador: item.auditor === 'ANA' ? 'BETO' : 'ANA' }), /atribuído/);
  await assert.rejects(AUD.cego(db, { endereco: '9-A-1', operador: 'ANA' }), /não está na auditoria/);
});

test('concluir: motivos, correção do estoque, lote fora da lista e bloqueio de repetição', async () => {
  const db = await novoDb(); await usuarios(db, 'ANA', 'BETO');
  const l1 = (await recebe(db, '1-A-1', 'LA', 10)).lote, l2 = (await recebe(db, '1-A-1', 'LB', 8, 'ANA', EAN2)).lote;
  await AUD.setN(db, 3);
  const item = (await AUD.planoDaSemana(db)).itens[0];
  assert.equal(item.endereco, '1-A-1');
  const op = item.auditor;
  await assert.rejects(AUD.concluir(db, { endereco: '1-A-1', operador: op, itens: [{ lote_id: l1.id, qtd: 10 }] }), /falta informar/);
  const r = await AUD.concluir(db, {
    endereco: '1-A-1', operador: op,
    itens: [{ lote_id: l1.id, qtd: 10 }, { lote_id: l2.id, qtd: 6 }],
    extras: [{ ean: EAN, lote: 'ACHADO', validade: mais(50), qtd: 3 }],
  });
  assert.equal(r.resultado.lotes, 3);
  assert.equal(r.resultado.confere, 1);
  assert.equal(r.resultado.diferencas, 2);
  assert.equal(r.resultado.acuracia, 33.3);
  const dif = r.resultado.itens.filter(i => !i.confere);
  assert.deepEqual(dif.map(i => [i.lote, i.sistema, i.contado, i.extra]).sort(), [['ACHADO', 0, 3, true], ['LB', 8, 6, false]]);
  const evs = await db.all("SELECT motivo, lote, qtd_depois FROM eventos WHERE motivo LIKE 'Auditoria:%' ORDER BY id");
  assert.deepEqual(evs.map(e => [e.lote, e.motivo]), [['LA', 'Auditoria: confere'], ['LB', 'Auditoria: diferença'], ['ACHADO', 'Auditoria: diferença']]);
  assert.equal((await db.get("SELECT qtd FROM lotes WHERE lote='LB'")).qtd, 6);        // a contagem corrige o estoque
  assert.equal((await db.get("SELECT qtd FROM lotes WHERE lote='ACHADO'")).qtd, 3);
  await assert.rejects(AUD.concluir(db, { endereco: '1-A-1', operador: op, itens: [] }), /já foi auditado/);
  const c = await AUD.cego(db, { endereco: '1-A-1', operador: op });
  assert.equal(c.ja_feito, true);
  const geral = await AUD.auditoria(db, { operador: op });
  assert.equal(geral.progresso.feitos, 1);
  assert.equal(geral.itens[0].status, 'feito');
});

test('contar zero marca diferença; lote repetido fora da lista é recusado', async () => {
  const db = await novoDb(); await usuarios(db, 'ANA', 'BETO');
  const l = (await recebe(db, '1-A-1', 'LA', 5)).lote;
  await AUD.setN(db, 3);
  const op = (await AUD.planoDaSemana(db)).itens[0].auditor;
  await assert.rejects(AUD.concluir(db, { endereco: '1-A-1', operador: op, itens: [{ lote_id: l.id, qtd: 0 }], extras: [{ ean: EAN, lote: 'LA', validade: l.validade, qtd: 1 }] }), /já está na lista/);
  const r = await AUD.concluir(db, { endereco: '1-A-1', operador: op, itens: [{ lote_id: l.id, qtd: 0 }] });
  assert.equal(r.resultado.diferencas, 1);
  assert.equal((await db.get("SELECT qtd FROM lotes WHERE lote='LA'")).qtd, 0);
});

test('acurácia por semana e por operador (contagem anterior), só admin vê o operador', async () => {
  const db = await novoDb(); await usuarios(db, 'ANA', 'BETO');
  await loja(db);
  const semana = AUD.semanaISO();
  // eventos de auditoria de semanas anteriores, escritos como o sistema escreve
  const agora = Date.now();
  async function aud(sem, ts, nlote, ok, ult) {
    const lote = (await recebe(db, `${nlote}-A-1`, `L${nlote}`, 0, 'ANA')).lote;   // garante o lote
    await db.run(`INSERT INTO eventos(ts,tipo,lote_id,ean,lote,validade,endereco,delta,qtd_antes,qtd_depois,operador,motivo,obs,grupo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [new Date(ts).toISOString(), 'CONTAGEM', lote.id, lote.ean, lote.lote, lote.validade, lote.endereco, 0, 5, ok ? 5 : 4, 'BETO',
      ok ? AUD.MOTIVO_OK : AUD.MOTIVO_DIF, `Auditoria ${sem}|ult=${ult}`, 'g' + Math.random()]);
  }
  const semAnt = AUD.semanasAte(2).shift();
  const ts = agora - 7 * 864e5;
  await aud(semAnt, ts, 1, true, 'ANA'); await aud(semAnt, ts + 1, 2, true, 'ANA'); await aud(semAnt, ts + 2, 3, false, 'ANA'); await aud(semAnt, ts + 3, 4, true, 'BETO');
  const p = await AUD.painel(db, { semanas: 8, admin: true });
  assert.equal(p.semanas.length, 8);
  const s = p.semanas.find(x => x.semana === semAnt);
  assert.deepEqual([s.lotes, s.confere, s.diferencas, s.acuracia], [4, 3, 1, 75]);
  assert.equal(p.semanas.at(-1).semana, semana);
  assert.equal(p.semanas.at(-1).acuracia, null);                    // semana corrente ainda sem auditoria
  assert.deepEqual(p.ultima, { semana: semAnt, acuracia: 75, lotes: 4 });
  const ana = p.por_operador.find(o => o.operador === 'ANA');
  assert.deepEqual([ana.lotes, ana.confere, ana.acuracia], [3, 2, 66.7]);
  assert.equal(p.por_operador.find(o => o.operador === 'BETO').acuracia, 100);
  assert.equal(p.atual.planejados, 5);
  const sem = await AUD.painel(db, { semanas: 8, admin: false });
  assert.equal(sem.por_operador, undefined);
  assert.equal(sem.geral.acuracia, 75);
});
