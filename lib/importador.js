// Importador flexível de listas de produtos e quantidades: planilha (.xlsx), CSV, TXT e XML de NF-e.
// Serve para carregar a lista da nota ("esperado") ou a lista de contagem do sistema da loja sem saber o formato de antemão:
// acha sozinho a linha do cabeçalho, aceita vários nomes por coluna e, se o arquivo não tiver cabeçalho, assume EAN;quantidade[;lote;validade].
// Só ANALISA: devolve as linhas já conferidas, sem gravar nada. Quem grava é a Conferência (ver conferencias.js).
const ExcelJS = require('exceljs');
const U = require('./util');
const NFE = require('./nfe');
const { HttpError } = U;

const MAX_ARQUIVO = 4 * 1024 * 1024;

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[º°ª]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// nomes de coluna aceitos (já normalizados)
const COLUNAS = {
  ean: ['ean', 'gtin', 'codigo de barras', 'cod barras', 'cod de barras', 'codbarras', 'codigo barras', 'barras', 'cean', 'ean13'],
  codigo: ['codigo', 'cod', 'cod produto', 'codigo produto', 'codigo do produto', 'cprod', 'sku', 'referencia', 'ref'],
  qtd: ['quantidade', 'qtd', 'qtde', 'qte', 'quant', 'contagem', 'contado', 'qtd contada', 'qtde contada', 'saldo', 'qcom', 'quantidade comercial'],
  lote: ['lote', 'lot', 'n lote', 'nlote', 'numero do lote'],
  validade: ['validade', 'vencimento', 'val', 'dt validade', 'data validade', 'data de validade', 'vcto', 'dval'],
  endereco: ['endereco', 'local', 'posicao', 'localizacao'],
  nome: ['descricao', 'produto', 'nome', 'descr', 'xprod', 'nome do produto', 'descricao do produto'],
  preco: ['preco', 'valor', 'vlr', 'preco venda', 'preco de venda'],
};

function mapearCabecalho(linha) {
  const nomes = linha.map(norm);
  const mapa = {}, usados = new Set();
  for (const passo of ['igual', 'comeca']) {
    for (const [campo, sin] of Object.entries(COLUNAS)) {
      if (mapa[campo] !== undefined) continue;
      for (const s of sin) {
        const i = nomes.findIndex((n, k) => !usados.has(k) && n && (passo === 'igual' ? n === s : n.startsWith(s + ' ')));
        if (i >= 0) { mapa[campo] = i; usados.add(i); break; }
      }
    }
  }
  return mapa;
}

const celula = v => {
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return v.result;
    if ('text' in v) return v.text;
    if (v.richText) return v.richText.map(t => t.text).join('');
  }
  return v;
};

// separador mais usado na primeira linha com conteúdo: ; , tab ou |
function detectaSep(txt) {
  const l = txt.split(/\r?\n/).find(x => x.trim()) || '';
  const conta = c => (l.match(new RegExp(c === '|' ? '\\|' : c, 'g')) || []).length;
  const cand = [';', '\t', ',', '|'].map(c => [c, conta(c)]).sort((a, b) => b[1] - a[1])[0];
  return cand[1] ? cand[0] : null;
}

function lerCsv(txt) {
  txt = txt.replace(/^﻿/, '');
  const sep = detectaSep(txt);
  const linhas = [];
  if (!sep) {                                          // TXT "EAN quantidade" separado por espaços
    for (const l of txt.split(/\r?\n/)) if (l.trim()) linhas.push(l.trim().split(/\s+/));
    return linhas;
  }
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) { if (c === '"' && txt[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') aspas = false; else campo += c; continue; }
    if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

async function lerLinhas(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {              // .xlsx é um zip ("PK")
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets.slice().sort((a, b) => b.actualRowCount - a.actualRowCount)[0];   // a aba com mais linhas
    if (!ws) throw new HttpError(400, 'planilha vazia');
    const linhas = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const l = [];
      row.eachCell({ includeEmpty: true }, (c, i) => { l[i - 1] = celula(c.value); });
      linhas.push(Array.from(l, v => (v === undefined ? null : v)));
    });
    return linhas;
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new HttpError(400, 'arquivo .xls antigo: abra no Excel e salve como .xlsx ou .csv');
  return lerCsv(buf.toString('utf8'));
}

// EAN de verdade: 8, 12, 13 ou 14 dígitos com dígito verificador
function gtinValido(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return false;
  let soma = 0;
  for (let i = d.length - 2, p = 3; i >= 0; i--, p = p === 3 ? 1 : 3) soma += +d[i] * p;
  return (10 - (soma % 10)) % 10 === +d[d.length - 1];
}

const ehData = v => v instanceof Date || (typeof v === 'string' && !!U.parseData(v));
const ehEanLike = v => /^\d{8,14}$/.test(String(v ?? '').replace(/\D/g, '')) && String(v ?? '').replace(/\D/g, '').length >= 8;
const ehInt = v => v !== null && v !== '' && /^\d+([.,]0+)?$/.test(String(v).trim());

// de uma tabela crua (linhas de células) para linhas { ean, codigo, nome, qtd, lote, validade, endereco, preco }
function extrairTabela(linhas) {
  let hi = -1, mapa = null;
  for (let i = 0; i < Math.min(15, linhas.length); i++) {
    const m = mapearCabecalho(linhas[i] || []);
    if ((m.ean !== undefined || m.codigo !== undefined) && m.qtd !== undefined) { hi = i; mapa = m; break; }
  }
  let semCabecalho = false;
  if (!mapa) {                                            // sem cabeçalho: EAN;quantidade[;lote;validade]
    const i0 = linhas.findIndex(l => (l || []).some(v => v !== null && String(v).trim() !== ''));
    const l0 = i0 >= 0 ? linhas[i0] : [];
    if (i0 >= 0 && ehEanLike(l0[0]) && ehInt(l0[1])) { mapa = { ean: 0, qtd: 1 }; if (l0.length > 2) mapa.lote = 2; if (l0.length > 3 && ehData(l0[3])) mapa.validade = 3; hi = i0 - 1; semCabecalho = true; }
  }
  if (!mapa) throw new HttpError(400, 'não achei as colunas: o arquivo precisa ter EAN (ou código) e quantidade. Se não tiver cabeçalho, use EAN;quantidade em cada linha.');
  const pega = (l, c) => (mapa[c] === undefined ? null : l[mapa[c]] ?? null);
  const out = [];
  for (let i = hi + 1; i < linhas.length; i++) {
    const l = linhas[i] || [];
    if (!l.some(v => v !== null && String(v).trim() !== '')) continue;
    out.push({ n: i + 1, ean: pega(l, 'ean'), codigo: pega(l, 'codigo'), nome: pega(l, 'nome'), qtd: pega(l, 'qtd'), lote: pega(l, 'lote'), validade: pega(l, 'validade'), endereco: pega(l, 'endereco'), preco: pega(l, 'preco') });
  }
  return { linhas: out, colunas: Object.keys(mapa), semCabecalho };
}

// um arquivo → linhas cruas
async function lerArquivo(nome, buf) {
  if (buf.length > MAX_ARQUIVO) throw new HttpError(413, `${nome}: arquivo grande demais (máx. 4 MB)`);
  const ini = buf.slice(0, 64).toString('utf8').replace(/^﻿/, '').trimStart();
  if (ini.startsWith('<')) {                              // XML de NF-e
    let nf;
    try { nf = NFE.parseNFe(buf.toString('utf8')); } catch (e) { throw new HttpError(400, `${nome}: ${e.message}`); }
    return { formato: 'xml', nota: { numero: nf.numero, serie: nf.serie, chave: nf.chave, emitente: nf.emitente, emissao: nf.emissao },
      colunas: ['ean', 'nome', 'qtd', ...(nf.itens.some(i => i.lote) ? ['lote', 'validade'] : [])],
      linhas: nf.itens.map((it, k) => ({ n: k + 1, ean: it.ean, codigo: it.codigo, nome: it.nome, qtd: it.qtd, lote: it.lote, validade: it.validade, endereco: null, preco: null })) };
  }
  const t = extrairTabela(await lerLinhas(buf));
  return { formato: buf[0] === 0x50 ? 'xlsx' : /\.txt$/i.test(nome) ? 'txt' : 'csv', nota: null, ...t };
}

// confere as linhas (EAN, quantidade, data) e marca o que o app já conhece
async function analisar(db, arquivos) {
  if (!Array.isArray(arquivos) || !arquivos.length) throw new HttpError(400, 'envie ao menos um arquivo');
  if (arquivos.length > 30) throw new HttpError(400, 'no máximo 30 arquivos por vez');
  const S = require('./service');
  const linhas = [], resumo = { arquivos: [], total: 0, validas: 0, com_erro: 0, nao_cadastrados: 0 };
  for (const a of arquivos) {
    const nome = String(a.nome || 'arquivo').slice(0, 120);
    const buf = Buffer.from(String(a.base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw new HttpError(400, `${nome}: arquivo vazio`);
    const r = await lerArquivo(nome, buf);
    resumo.arquivos.push({ nome, formato: r.formato, colunas: r.colunas, linhas: r.linhas.length, nota: r.nota, sem_cabecalho: !!r.semCabecalho });
    for (const x of r.linhas) {
      const erros = [], avisos = [];
      let ean = U.normEan(x.ean);
      let prod = null;
      if (ean && ean.length < 8) { erros.push('o código ' + ean + ' parece código interno, não EAN'); ean = null; }
      else if (!ean) {
        const cod = String(x.codigo ?? '').trim();
        erros.push(cod ? `só tem o código interno ${cod}, sem EAN` : 'sem EAN');
      } else {
        if (!gtinValido(ean)) avisos.push('o dígito verificador do EAN não confere');
        prod = await S.getProduto(db, ean);
      }
      const q = Number(String(x.qtd ?? '').replace(',', '.'));
      if (!Number.isFinite(q) || q < 0) erros.push('quantidade inválida');
      else if (!Number.isInteger(q)) avisos.push('quantidade fracionada: foi arredondada');
      let validade = null;
      if (x.validade !== null && x.validade !== undefined && String(x.validade).trim() !== '') {
        validade = U.parseData(x.validade);
        if (!validade) erros.push('validade inválida');
      }
      const nomeProd = prod ? prod.nome : (x.nome ? String(x.nome).trim() : null);
      if (ean && !prod) resumo.nao_cadastrados++;
      linhas.push({ arquivo: nome, n: x.n, ean, nome: nomeProd, cadastrado: !!prod, qtd: Number.isFinite(q) ? Math.round(q) : null,
        lote: x.lote ? U.normLote(x.lote) : null, validade, endereco: x.endereco ? U.normEndereco(x.endereco) : null, erros, avisos });
    }
  }
  resumo.total = linhas.length;
  resumo.com_erro = linhas.filter(l => l.erros.length).length;
  resumo.validas = resumo.total - resumo.com_erro;
  return { resumo, linhas };
}

const ROTAS = [
  ['POST', /^\/api\/importar\/analisar$/, {}, c => analisar(c.db, c.body.arquivos)],
];
const LIMITE_CORPO = { '/api/importar/analisar': Math.ceil(MAX_ARQUIVO * 4 / 3) + 8192 };

module.exports = { ROTAS, LIMITE_CORPO, analisar, extrairTabela, lerLinhas, lerCsv, mapearCabecalho, gtinValido, lerArquivo };
