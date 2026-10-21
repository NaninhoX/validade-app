'use strict';
// Validação pura das linhas lidas da folha de papel (FIFO manuscrita). Nada aqui acessa rede ou banco:
// a rota consulta o catálogo e passa um Map ean -> nome em `catalogo`.
const U = require('./util');

function digitoEan13(doze) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += +doze[i] * (i % 2 ? 3 : 1);
  return (10 - (s % 10)) % 10;
}

function eanValido(ean) {
  return /^\d{13}$/.test(ean) && digitoEan13(ean) === +ean[12];
}

const soDigitos = v => (v === null || v === undefined ? '' : String(v).replace(/\D/g, ''));

// Candidatos a correção de um EAN mal lido: troca de 1 dígito e troca de dois dígitos vizinhos
// (e, se faltar ou sobrar um dígito, inserção/remoção). Só devolve os que passam no dígito verificador.
function candidatosEan(ean) {
  const out = new Set();
  const add = c => { if (c !== ean && eanValido(c)) out.add(c); };
  if (!/^\d+$/.test(ean || '')) return [];
  if (ean.length === 13) {
    for (let i = 0; i < 13; i++) for (let d = 0; d <= 9; d++) if (String(d) !== ean[i]) add(ean.slice(0, i) + d + ean.slice(i + 1));
    for (let i = 0; i < 12; i++) if (ean[i] !== ean[i + 1]) add(ean.slice(0, i) + ean[i + 1] + ean[i] + ean.slice(i + 2));
  } else if (ean.length === 12) {
    for (let i = 0; i <= 12; i++) for (let d = 0; d <= 9; d++) add(ean.slice(0, i) + d + ean.slice(i));
  } else if (ean.length === 14) {
    for (let i = 0; i < 14; i++) add(ean.slice(0, i) + ean.slice(i + 1));
  }
  return [...out];
}

// Todos os EANs a procurar no catálogo (os lidos e os candidatos), para uma única consulta.
function candidatosDeLinhas(linhas) {
  const s = new Set();
  for (const l of linhas) {
    const e = soDigitos(l.ean);
    if (e) { s.add(e); candidatosEan(e).forEach(c => s.add(c)); }
  }
  return [...s];
}

// dd/mm/aa ou dd/mm/aaaa (também 6/8 dígitos corridos ou ISO) -> ISO; null se não for data real
function dataISO(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return U.parseData(s);
  const m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/) || s.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/);
  if (!m) return null;
  return U.parseData(`${m[1]}/${m[2]}/${m[3]}`);
}

function somaDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// null se plausível; senão o motivo
function validadePlausivel(iso, hoje = U.hojeISO()) {
  if (iso < somaDias(hoje, -365)) return 'Validade com mais de 1 ano no passado, confira o ano';
  const limite = new Date(hoje + 'T00:00:00Z'); limite.setUTCFullYear(limite.getUTCFullYear() + 5);
  if (iso > limite.toISOString().slice(0, 10)) return 'Validade a mais de 5 anos, confira o ano';
  return null;
}

const loteValido = l => /^[A-Za-z0-9]{1,12}$/.test(l);

function qtdValida(q) {
  const s = String(q ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = +s;
  return n >= 1 && n <= 999 ? n : null;
}

// linhas: [{data_lancamento, ean, lote, validade, qtd}] como o OCR devolveu.
// catalogo: Map ean -> nome dos EANs que existem no catálogo (basta conter os de candidatosDeLinhas()).
// Cada linha volta com status 'ok' | 'duvidosa', motivos (texto para a pessoa) e bloqueios (subconjunto que impede lançar).
function validarLinhas(linhas, { catalogo = new Map(), hoje = U.hojeISO() } = {}) {
  const tem = e => catalogo.has(e);
  const nome = e => catalogo.get(e) || '';
  const vistos = new Map();
  return (linhas || []).map((r, i) => {
    const motivos = [], bloqueios = [];
    const dup = (txt, bloqueia = true) => { motivos.push(txt); if (bloqueia) bloqueios.push(txt); };
    const ean = soDigitos(r.ean);
    const lote = String(r.lote ?? '').trim().toUpperCase().replace(/\s+/g, '');
    const validade = dataISO(r.validade);
    const lancamento = r.data_lancamento ? dataISO(r.data_lancamento) : null;
    const qtd = qtdValida(r.qtd);
    let sugestoes = [];
    let produto = null;

    if (!ean) dup('EAN não lido');
    else if (eanValido(ean) && tem(ean)) produto = nome(ean);
    else {
      const soma = eanValido(ean);
      if (!soma) dup(ean.length === 13 ? 'EAN com dígito verificador inválido (provável erro de leitura)' : `EAN com ${ean.length} dígitos (deveria ter 13)`);
      else dup('EAN válido, mas não cadastrado no catálogo', false);
      sugestoes = candidatosEan(ean).filter(tem).map(c => ({ ean: c, nome: nome(c) }));
      if (sugestoes.length) motivos.push(sugestoes.length === 1 ? 'Há 1 EAN parecido no catálogo' : `Há ${sugestoes.length} EANs parecidos no catálogo`);
    }
    if (!lote) dup('Lote não lido');
    else if (!loteValido(lote)) dup('Lote deve ter de 1 a 12 letras ou números');
    if (!validade) dup('Validade ilegível ou data inexistente (use dd/mm/aa)');
    else { const p = validadePlausivel(validade, hoje); if (p) dup(p, false); }
    if (r.data_lancamento && !lancamento) dup('Data de lançamento ilegível', false);
    if (qtd === null) dup('Quantidade deve ser um inteiro de 1 a 999');

    if (ean && lote && validade) {
      const chave = `${ean}|${lote}|${validade}`;
      if (vistos.has(chave)) dup(`Linha repetida (igual à linha ${vistos.get(chave)})`, false);
      else vistos.set(chave, i + 1);
    }
    return {
      n: i + 1, data_lancamento: lancamento, ean, lote, validade: validade || '', qtd: qtd === null ? String(r.qtd ?? '') : qtd,
      produto, sugestoes, status: motivos.length ? 'duvidosa' : 'ok', motivos, bloqueios,
      original: { data_lancamento: r.data_lancamento ?? '', ean: r.ean ?? '', lote: r.lote ?? '', validade: r.validade ?? '', qtd: r.qtd ?? '' },
    };
  });
}

module.exports = { digitoEan13, eanValido, candidatosEan, candidatosDeLinhas, dataISO, validadePlausivel, loteValido, qtdValida, validarLinhas, soDigitos };
