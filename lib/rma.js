// Lista de avaria e RMA no formato do "Registro de avaria" do sistema da loja:
// produto, lote, situação (Vencido ou Avariado), validade (só para vencidos), causa e quantidade.
// Sai das baixas feitas aqui (RMA, avaria, retirada preventiva), para quem lança no sistema da loja não precisar reler papel.
const U = require('./util');
const { HttpError } = U;

const MOTIVOS = ['RMA', 'Avaria', 'Retirada Preventiva'];
const COL = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const celula = v => { const s = v === null || v === undefined ? '' : String(v); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const diaOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function periodo(q) {
  const ate = diaOk(q.ate) ? q.ate : U.hojeISO();
  const de = diaOk(q.de) ? q.de : U.hojeISO(new Date(Date.parse(ate + 'T12:00:00Z') - 6 * 864e5));
  if (de > ate) throw new HttpError(400, 'a data inicial é depois da final');
  if ((Date.parse(ate) - Date.parse(de)) / 864e5 > 92) throw new HttpError(400, 'período grande demais (máx. 92 dias)');
  return { de, ate };
}

async function lista(db, q = {}) {
  const { de, ate } = periodo(q);
  const desde = new Date(Date.parse(de + 'T00:00:00Z') - 864e5).toISOString();            // folga de fuso; o filtro final é pelo dia da loja
  const evs = await db.all(`SELECT e.ts, e.ean, e.lote, e.validade, e.delta, e.motivo, e.causa, e.operador, p.nome, p.marca
    FROM eventos e LEFT JOIN produtos p ON p.ean = e.ean
    WHERE e.tipo='BAIXA' AND e.desfeito=0 AND e.motivo IN (?,?,?) AND e.ts >= ?`, [...MOTIVOS, desde]);
  const mapa = new Map();
  for (const e of evs) {
    const dia = U.hojeISO(new Date(e.ts));
    if (dia < de || dia > ate) continue;
    const vencido = !!e.validade && e.validade <= dia;
    const situacao = vencido ? 'Vencido' : 'Avariado';
    const causa = e.causa ? `${e.motivo}: ${e.causa}` : e.motivo;
    const k = [e.ean, e.lote || '', situacao, causa].join('|');
    const x = mapa.get(k) || { ean: e.ean, nome: e.nome || e.ean, marca: e.marca || '', lote: e.lote || '', situacao, validade: vencido ? e.validade : null, causa, qtd: 0, dias: new Set(), operadores: new Set() };
    x.qtd += -Number(e.delta); x.dias.add(dia); x.operadores.add(e.operador || '');
    mapa.set(k, x);
  }
  const itens = [...mapa.values()].map(x => ({ ...x, dias: [...x.dias].sort(), operadores: [...x.operadores].filter(Boolean) }))
    .sort((a, b) => COL.compare(a.nome, b.nome) || COL.compare(a.lote, b.lote));
  return { de, ate, itens, totais: { linhas: itens.length, qtd: itens.reduce((s, i) => s + i.qtd, 0), vencidos: itens.filter(i => i.situacao === 'Vencido').length, avariados: itens.filter(i => i.situacao === 'Avariado').length } };
}

async function csv(db, q) {
  const r = await lista(db, q);
  const linhas = [['Produto', 'EAN', 'Lote', 'Situação', 'Validade (só vencidos)', 'Causa', 'Qtd', 'Dia(s)']];
  for (const i of r.itens) linhas.push([i.nome, i.ean, i.lote, i.situacao, i.validade ? U.brData(i.validade) : '', i.causa, i.qtd, i.dias.map(U.brData).join(' ')]);
  return { __raw: { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="avaria-rma-${r.de}-a-${r.ate}.csv"`, 'Cache-Control': 'no-store' },
    body: Buffer.from('﻿' + linhas.map(l => l.map(celula).join(';')).join('\r\n') + '\r\n', 'utf8') } };
}

const ROTAS = [
  ['GET', /^\/api\/rma$/, {}, c => lista(c.db, { de: c.q.get('de'), ate: c.q.get('ate') })],
  ['GET', /^\/api\/rma\.csv$/, {}, c => csv(c.db, { de: c.q.get('de'), ate: c.q.get('ate') })],
];

module.exports = { ROTAS, lista, csv };
