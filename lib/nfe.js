// Leitura de NF-e sem dependências: o XML (o arquivo que o ERP baixa da SEFAZ) e a chave de acesso de 44 dígitos
// (o código de barras do DANFE). Não consulta a SEFAZ: usa só o que vem no arquivo ou na própria chave.
// Adaptado do projeto de armazenagem; aqui o foco são os ITENS (EAN, nome, quantidade, lote e validade).
const soDigitos = s => String(s ?? '').replace(/\D/g, '');
const numero = s => { const n = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const texto = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m)).trim();

// trecho interno da primeira (ou de todas as) <tag>; aceita prefixo de namespace (<nfe:tag>)
function blocos(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const bloco = (xml, tag) => (xml ? blocos(xml, tag)[0] ?? null : null);
const valor = (xml, tag) => { const b = bloco(xml, tag); return b === null ? null : texto(b); };

// Chave: cUF(2) AAMM(4) CNPJ(14) modelo(2) série(3) número(9) tpEmis(1) código(8) DV(1)
function dvChave(chave43) {
  let soma = 0, peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) { soma += +chave43[i] * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}
function chaveValida(c) {
  c = soDigitos(c);
  return c.length === 44 && dvChave(c.slice(0, 43)) === +c[43];
}
function parseChave(c) {
  c = soDigitos(c);
  if (c.length !== 44) return { valida: false, erro: 'a chave tem 44 números' };
  if (!chaveValida(c)) return { valida: false, erro: 'dígito verificador não confere: confira a chave' };
  const aa = +c.slice(2, 4), mm = +c.slice(4, 6);
  return {
    valida: true, chave: c, uf: c.slice(0, 2), emissao_mes: `20${String(aa).padStart(2, '0')}-${String(mm).padStart(2, '0')}`,
    cnpj: c.slice(6, 20), modelo: c.slice(20, 22), serie: String(+c.slice(22, 25)), numero: String(+c.slice(25, 34)),
  };
}

// "SEM GTIN" é o que o emitente escreve quando o produto não tem código de barras
const eanDe = (p, ...tags) => { for (const t of tags) { const v = soDigitos(valor(p, t)); if (v.length >= 8) return v; } return ''; };

// Itens da nota. Se o produto traz rastreio (<rastro>: lote, validade, quantidade do lote), cada lote vira uma linha.
function itensDe(inf) {
  const out = [];
  for (const d of blocos(inf, 'det')) {
    const p = bloco(d, 'prod'); if (!p) continue;
    const ean = eanDe(p, 'cEAN', 'cEANTrib'), nome = valor(p, 'xProd') || '', un = valor(p, 'uCom') || '', codigo = valor(p, 'cProd') || '';
    const qCom = numero(valor(p, 'qCom')) ?? 0;
    const rastros = blocos(p, 'rastro');
    if (rastros.length) {
      for (const r of rastros) out.push({ ean, codigo, nome, un, qtd: numero(valor(r, 'qLote')) ?? qCom, lote: valor(r, 'nLote') || null, validade: (valor(r, 'dVal') || '').slice(0, 10) || null });
    } else out.push({ ean, codigo, nome, un, qtd: qCom, lote: null, validade: null });
  }
  return out;
}

function parseNFe(xml) {
  xml = String(xml || '');
  if (!/<(?:\w+:)?infNFe[\s>]/.test(xml)) throw new Error('não parece um XML de NF-e (sem <infNFe>)');
  const inf = bloco(xml, 'infNFe');
  const id = (xml.match(/<(?:\w+:)?infNFe[^>]*\sId="NFe(\d{44})"/) || [])[1] || valor(xml, 'chNFe');
  const ide = bloco(inf, 'ide'), emit = bloco(inf, 'emit'), dest = bloco(inf, 'dest');
  return {
    chave: id ? soDigitos(id) : null,
    numero: valor(ide, 'nNF'), serie: valor(ide, 'serie') ?? '',
    emissao: (valor(ide, 'dhEmi') || valor(ide, 'dEmi') || '').slice(0, 10) || null,
    natureza: valor(ide, 'natOp'),
    emitente: valor(emit, 'xNome'), emitente_cnpj: soDigitos(valor(emit, 'CNPJ') || valor(emit, 'CPF')),
    destinatario: valor(dest, 'xNome'), destinatario_cnpj: soDigitos(valor(dest, 'CNPJ') || valor(dest, 'CPF')),
    valor: numero(valor(bloco(inf, 'ICMSTot'), 'vNF')) ?? 0,
    itens: itensDe(inf),
  };
}

module.exports = { parseNFe, parseChave, chaveValida, dvChave };
