const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/geom.js');

const R = (id, x, y, w = 40, h = 20) => ({ id, x, y, w, h });
const pos = (plano, id) => plano.pos.find(p => p.id === id);
const perto = (a, b, e = 0.11) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

test('tamanho derivado: módulos × comprimento + pontas, profundidade pelos lados', () => {
  const padrao = { modulo_c: 140, modulo_l: 40, ponta_c: 100, ponta_p: 40 };
  const g = G.geometria({ cfg: { modulos: 5, lados: 'AB' }, padrao });
  assert.equal(g.L, 2 * 40 + 5 * 140);           // 780
  assert.equal(g.T, 100);                        // max(2 × 40, ponta 100)
  assert.equal(G.geometria({ cfg: { modulos: 5, lados: 'AB', dim: { modulo_l: 70 } }, padrao }).T, 140);
  assert.equal(G.geometria({ cfg: { modulos: 3, lados: 'B' }, padrao }).L, 80 + 420);
  assert.equal(G.geometria({ cfg: { modulos: 3, lados: 'B', dim: { modulo_c: 100 } }, padrao }).L, 80 + 300);
  assert.equal(G.geometria({ cfg: {}, padrao }).n, 5);                                  // padrão: 5 módulos, 2 lados
  const c = G.tamanhoCaixa(g, 0, 0.2);
  perto(c.w, 156); perto(c.h, 20);
  const v = G.tamanhoCaixa(g, 90, 0.2);                                                // girada troca os eixos
  perto(v.w, 20); perto(v.h, 156);
});

test('tamanho derivado: sacaria usa c e l da área; mudar medida padrão ou módulos muda a caixa', () => {
  const a = G.geometria({ area: true, cfg: { c: 800, l: 300 } });
  assert.deepEqual([a.L, a.T], [800, 300]);
  assert.deepEqual([G.geometria({ area: true, cfg: {} }).L, G.geometria({ area: true, cfg: {} }).T], [600, 400]);
  const antes = G.tamanhoCaixa(G.geometria({ cfg: { modulos: 5 }, padrao: G.DIM0 }), 0, 0.2).w;
  const maisMod = G.tamanhoCaixa(G.geometria({ cfg: { modulos: 6 }, padrao: G.DIM0 }), 0, 0.2).w;
  const medida = G.tamanhoCaixa(G.geometria({ cfg: { modulos: 5 }, padrao: { ...G.DIM0, modulo_c: 160 } }), 0, 0.2).w;
  perto(maisMod - antes, 140 * 0.2); perto(medida - antes, 5 * 20 * 0.2);
});

test('migração: layout antigo ganha escala mediana e caixas derivadas, mantendo o centro', () => {
  const geoDe = id => (id === 19 ? { area: true, L: 600, T: 400 } : { area: false, L: 780, T: 100 });
  const antigo = { largura: 1000, altura: 500, gondolas: [
    { id: 1, x: 100, y: 100, w: 156, h: 20, rot: 0 }, { id: 2, x: 100, y: 200, w: 234, h: 30, rot: 0 }, { id: 3, x: 400, y: 100, w: 195, h: 25, rot: 0 }, { id: 19, x: 600, y: 300, w: 100, h: 60, rot: 0 }] };
  const { layout, migrou } = G.migrarLayout(antigo, geoDe);
  assert.equal(migrou, true);
  assert.equal(layout.escala, 0.25);                                  // mediana de 0.2, 0.3, 0.25 (a área não conta)
  assert.equal(antigo.escala, undefined);                             // original intacto
  const g1 = layout.gondolas[0];
  perto(g1.w, 195); perto(g1.h, 25);
  perto(g1.x + g1.w / 2, 100 + 78); perto(g1.y + g1.h / 2, 100 + 10);  // mesmo centro
  assert.equal(G.migrarLayout(layout, geoDe).migrou, false);          // idempotente
  assert.equal(G.medianaEscala([]), 0.2);
});

test('sincronizaCaixas grava w/h derivados no formato antigo', () => {
  const L = { escala: 0.1, largura: 500, altura: 300, gondolas: [{ id: 1, x: 0, y: 0, w: 1, h: 1, rot: 90 }] };
  G.sincronizaCaixas(L, () => ({ L: 780, T: 100 }));
  assert.deepEqual([L.gondolas[0].w, L.gondolas[0].h], [10, 78]);
});

test('metros e pixels pela escala', () => {
  perto(G.pxParaM(1000, 0.2), 50); perto(G.mParaPx(50, 0.2), 1000);
});

test('alinhar: esquerda, centro, direita, topo, meio, base', () => {
  const rs = [R(1, 10, 10, 40, 20), R(2, 100, 50, 60, 30), R(3, 40, 90, 20, 10)];
  const x = m => G.alinhar(rs, m).map(p => p.x), y = m => G.alinhar(rs, m).map(p => p.y);
  assert.deepEqual(x('esq'), [10, 10, 10]);
  assert.deepEqual(x('dir'), [120, 100, 140]);
  assert.deepEqual(x('centro'), [65, 55, 75]);                         // caixa 10..160, centro 85
  assert.deepEqual(y('topo'), [10, 10, 10]);
  assert.deepEqual(y('base'), [80, 70, 90]);
  assert.deepEqual(y('meio'), [45, 40, 50]);                           // caixa 10..100, centro 55
  assert.deepEqual(G.alinhar([], 'esq'), []);
});

test('distribuir: vãos iguais, extremos fixos, exige 3', () => {
  const rs = [R(1, 0, 0, 20, 10), R(2, 30, 0, 40, 10), R(3, 200, 0, 20, 10), R(4, 90, 0, 10, 10)];
  const d = G.distribuir(rs, 'h');
  assert.equal(d.ok, true);
  const p = id => pos(d, id).x;
  assert.equal(p(1), 0); assert.equal(p(3), 200);
  const o = [1, 2, 4, 3].map(id => ({ id, x: p(id), w: rs.find(r => r.id === id).w }));
  const vaos = o.slice(1).map((r, i) => r.x - (o[i].x + o[i].w));
  assert.ok(vaos.every(v => Math.abs(v - vaos[0]) < 0.2), vaos.join());
  assert.equal(G.distribuir(rs.slice(0, 2), 'h').ok, false);
  const v = G.distribuir([R(1, 0, 0, 10, 20), R(2, 0, 10, 10, 20), R(3, 0, 100, 10, 20)], 'v');
  assert.equal(pos(v, 2).y, 50); assert.equal(pos(v, 2).x, 0);          // (120 - 60) / 2 = 30 de vão
  assert.equal(G.distribuir([R(1, 0, 0, 50, 10), R(2, 10, 0, 50, 10), R(3, 60, 0, 10, 10)], 'h').ok, false);   // extremos apertados demais
});

test('agrupar: valores próximos entram no mesmo grupo, em ordem', () => {
  assert.deepEqual(G.agrupar([100, 5, 103, 8, 300], 6), [[1, 3], [0, 2], [4]]);
  assert.deepEqual(G.agrupar([], 5), []);
  assert.deepEqual(G.agrupar([0, 5, 10, 15], 5), [[0, 1, 2, 3]]);       // encadeia
  const rs = [R(1, 0, 10), R(2, 100, 14), R(3, 0, 80), R(4, 100, 79)];
  assert.deepEqual(G.linhasDe(rs, 10).map(l => l.map(r => r.id)), [[1, 2], [4, 3].sort((a, b) => rs.find(r => r.id === a).x - rs.find(r => r.id === b).x)]);
  assert.deepEqual(G.colunasDe(rs, 10).map(c => c.map(r => r.id)), [[1, 3], [2, 4]]);
});

test('organizar 1: alinha linhas e colunas sem mudar a ordem', () => {
  const rs = [R(1, 0, 10), R(2, 100, 14), R(3, 3, 80), R(4, 101, 79)];
  const p = G.planoAlinhar(rs, { tol: 10 });
  assert.equal(p.ok, true);
  assert.equal(pos(p, 1).y, pos(p, 2).y); assert.equal(pos(p, 3).y, pos(p, 4).y);       // linhas alinhadas
  assert.equal(pos(p, 1).x, pos(p, 3).x); assert.equal(pos(p, 2).x, pos(p, 4).x);       // colunas alinhadas
  assert.ok(pos(p, 1).x < pos(p, 2).x && pos(p, 1).y < pos(p, 3).y);                    // ordem mantida
  assert.equal(G.valida(rs, p.pos, { x: 0, y: 0, w: 300, h: 200 }).ok, true);
  assert.equal(G.planoAlinhar([R(1, 0, 0)], { tol: 5 }).ok, false);
});

test('organizar 2: espaçamento igual entre gôndolas e entre linhas', () => {
  const rs = [R(1, 0, 0), R(2, 60, 0), R(3, 160, 0), R(4, 0, 50), R(5, 90, 50)];
  const p = G.planoEspacamento(rs, { tol: 5, gapMin: 5 });
  assert.equal(p.ok, true);
  const gaps = (a, b) => pos(p, b).x - (pos(p, a).x + 40);
  perto(gaps(1, 2), gaps(2, 3)); perto(gaps(1, 2), p.gapH);
  perto(gaps(4, 5), p.gapH);
  perto(pos(p, 4).y - (pos(p, 1).y + 20), p.gapV);
  assert.equal(pos(p, 1).x, 0);                                                          // a primeira de cada linha fica onde estava
  assert.equal(G.valida(rs, p.pos, { x: 0, y: 0, w: 400, h: 300 }).ok, true);
  assert.equal(G.valida(rs, p.pos, { x: 0, y: 0, w: 150, h: 300 }).ok, false);          // não cabe no perímetro
});

test('organizar 3: grade ordenada por número, corredores iguais, dentro do perímetro', () => {
  const rs = [R(5, 300, 10), R(1, 10, 200), R(3, 120, 5), R(2, 0, 0), R(4, 80, 90), R(6, 5, 5)];
  const area = { x: 0, y: 0, w: 400, h: 200 };
  const p = G.planoGrade(rs, { area, colunas: 3, gapMin: 10 });
  assert.equal(p.ok, true); assert.equal(p.colunas, 3); assert.equal(p.linhas, 2);
  const a = id => pos(p, id);
  assert.ok(a(1).x < a(2).x && a(2).x < a(3).x && a(1).y === a(2).y);                    // ordem por número, linha por linha
  assert.ok(a(4).y > a(1).y && a(4).x === a(1).x);
  perto(a(2).x - (a(1).x + 40), a(3).x - (a(2).x + 40)); perto(a(2).x - (a(1).x + 40), p.gapH);
  perto(a(1).x, p.gapH); perto(400 - (a(3).x + 40), p.gapH);                             // corredor também nas bordas
  assert.equal(G.valida(rs, p.pos, area).ok, true);
  // sem número de colunas, escolhe uma que caiba
  const auto = G.planoGrade(rs, { area, colunas: 0, gapMin: 10 });
  assert.equal(auto.ok, true); assert.equal(G.valida(rs, auto.pos, area).ok, true);
});

test('organizar 3: gap máximo centraliza; não cabe é dito, nunca sobrepõe', () => {
  const rs = [R(1, 0, 0), R(2, 50, 0), R(3, 100, 0)];
  const folga = G.planoGrade(rs, { area: { x: 0, y: 0, w: 1000, h: 500 }, colunas: 3, gapMin: 10, gapMax: 30 });
  assert.equal(folga.ok, true); assert.equal(folga.gapH, 30);
  perto(pos(folga, 1).x + 40 + 30, pos(folga, 2).x);
  perto(pos(folga, 1).x, 1000 - (pos(folga, 3).x + 40));                                // centrada
  const apertado = G.planoGrade(rs, { area: { x: 0, y: 0, w: 130, h: 500 }, colunas: 3, gapMin: 10 });
  assert.equal(apertado.ok, false); assert.match(apertado.motivo, /Não cabe/); assert.deepEqual(apertado.pos, []);
  const nada = G.planoGrade([R(1, 0, 0, 100, 100), R(2, 0, 0, 100, 100)], { area: { x: 0, y: 0, w: 120, h: 120 }, colunas: 0, gapMin: 10 });
  assert.equal(nada.ok, false);
});

test('faixa livre para a entrada reduz a área da grade', () => {
  const lim = { x: 0, y: 0, w: 400, h: 300 };
  assert.deepEqual(G.areaLivre(lim, { lado: 'baixo', tam: 80 }), { x: 0, y: 0, w: 400, h: 220 });
  assert.deepEqual(G.areaLivre(lim, { lado: 'cima', tam: 80 }), { x: 0, y: 80, w: 400, h: 220 });
  assert.deepEqual(G.areaLivre(lim, { lado: 'esq', tam: 100 }), { x: 100, y: 0, w: 300, h: 300 });
  assert.deepEqual(G.areaLivre(lim, { lado: 'dir', tam: 100 }), { x: 0, y: 0, w: 300, h: 300 });
  assert.deepEqual(G.areaLivre(lim, null), lim);
  const rs = [R(1, 0, 0, 100, 40), R(2, 0, 0, 100, 40), R(3, 0, 0, 100, 40), R(4, 0, 0, 100, 40)];
  const area = G.areaLivre(lim, { lado: 'baixo', tam: 120 });
  const p = G.planoGrade(rs, { area, colunas: 2, gapMin: 10 });
  assert.equal(p.ok, true);
  assert.ok(p.pos.every(q => q.y + 40 <= 300 - 120 + 0.01));                             // nada invade a faixa da entrada
});

test('valida: detecta sobreposição e saída do perímetro, ignora quem não mexeu', () => {
  const todos = [R(1, 0, 0), R(2, 100, 0), R(3, 10, 10)];            // 1 e 3 já se sobrepõem
  const lim = { x: 0, y: 0, w: 300, h: 100 };
  assert.equal(G.valida(todos, [{ id: 2, x: 200, y: 0 }], lim).ok, true);
  assert.match(G.valida(todos, [{ id: 2, x: 30, y: 5 }], lim).motivo, /sobrepostas/);
  assert.match(G.valida(todos, [{ id: 2, x: 280, y: 0 }], lim).motivo, /perímetro/);
  assert.equal(G.valida(todos, [{ id: 1, x: 0, y: 0 }, { id: 3, x: 10, y: 10 }, { id: 2, x: 200, y: 0 }], lim).ok, true);     // 1 e 3 não se mexeram: a sobreposição antiga não conta
  assert.equal(G.valida([R(1, 0, 0), R(2, 40, 0)], [{ id: 2, x: 40, y: 0 }], lim).ok, true);   // encostar não é sobrepor
});

test('limitaGrupo mantém o grupo dentro do perímetro', () => {
  const rs = [R(1, 10, 10), R(2, 100, 50)];
  const lim = { x: 0, y: 0, w: 200, h: 100 };
  assert.deepEqual(G.limitaGrupo(rs, -50, 500, lim), { dx: -10, dy: 30 });
  assert.deepEqual(G.limitaGrupo(rs, 500, -50, lim), { dx: 60, dy: -10 });
});

test('próximo número livre e cópia de configuração', () => {
  assert.equal(G.proximoLivre(new Set([1, 2, 20, 21])), 22);
  assert.equal(G.proximoLivre(new Set(Array.from({ length: 21 }, (_, i) => i + 20))), 1);
  assert.equal(G.proximoLivre(new Set(Array.from({ length: 40 }, (_, i) => i + 1))), null);
  const orig = { tipo: 'gondola', nome: 'X', lados: 'B', modulos: 4, dim: { modulo_c: 120 }, nomes: { 'B-1': 'Fantasia' }, resp: ['DAVI'], setores: { B: {} } };
  const c = G.copiaCfg(orig);
  assert.deepEqual(c, { tipo: 'gondola', nome: 'X', lados: 'B', modulos: 4, dim: { modulo_c: 120 }, nomes: { 'B-1': 'Fantasia' } });
  c.nomes['B-2'] = 'y'; c.dim.modulo_c = 1;
  assert.equal(orig.nomes['B-2'], undefined); assert.equal(orig.dim.modulo_c, 120);
  const area = G.copiaCfg({ tipo: 'area', c: 600, l: 400, pallets: [{ id: 1, x: 0, y: 0, c: 100, l: 100, nome: 'a' }] });
  area.pallets[0].nome = 'b';
  assert.equal(area.c, 600); assert.equal(area.pallets.length, 1);
});
