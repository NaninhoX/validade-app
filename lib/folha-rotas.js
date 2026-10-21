'use strict';
// Rotas da importação da folha de papel. Ficam fora do app.js para não conflitar com outras mudanças.
const U = require('./util');
const S = require('./service');
const F = require('./folha');
const OCR = require('./ocr');
const { HttpError } = U;

const MAX_FOTO = 4 * 1024 * 1024;   // bytes da imagem já decodificada
// limite do corpo JSON (base64 pesa ~4/3 da imagem). Atenção: a Vercel limita o corpo a ~4,5 MB; o app reduz a foto antes de enviar.
const LIMITE_CORPO = { '/api/folha/ler': Math.ceil(MAX_FOTO * 4 / 3) + 4096, '/api/folha/lancar': 1024 * 1024 };

// Extrator padrão (lê ANTHROPIC_API_KEY a cada chamada); os testes trocam com setExtrator().
let extrator = OCR.criarExtrator();
const setExtrator = fn => { extrator = fn || OCR.criarExtrator(); };

async function catalogoDe(db, eans) {
  const m = new Map();
  if (!eans.length) return m;
  const rows = await db.all(`SELECT ean, nome FROM produtos WHERE ean IN (${eans.map(() => '?').join(',')})`, eans);
  rows.forEach(r => m.set(r.ean, r.nome));
  return m;
}

async function validar(db, linhas, hoje) {
  const catalogo = await catalogoDe(db, F.candidatosDeLinhas(linhas));
  return F.validarLinhas(linhas, { catalogo, hoje });
}

async function ler(c) {
  const foto = c.body && c.body.foto;
  if (typeof foto !== 'string' || !foto) throw new HttpError(400, 'Envie a foto da folha.');
  const { base64 } = OCR.lerDataUrl(foto);
  if (Math.floor(base64.length * 3 / 4) > MAX_FOTO) throw new HttpError(413, 'A foto é grande demais (máximo de 4 MB). Tire outra com menos resolução.');
  const bruto = await extrator(foto);
  if (!bruto.length) throw new HttpError(422, 'Não encontrei linhas preenchidas na foto. Tente de novo, com a folha inteira, de frente e bem iluminada.');
  const linhas = await validar(c.db, bruto.slice(0, 300));
  return { linhas, ok: linhas.filter(l => l.status === 'ok').length, duvidosas: linhas.filter(l => l.status === 'duvidosa').length };
}

// Recebe as linhas confirmadas pela pessoa e valida de novo no servidor: linha com bloqueio volta em `falhas`, sem gravar.
async function lancar(c) {
  const entrada = Array.isArray(c.body.linhas) ? c.body.linhas : [];
  if (!entrada.length) throw new HttpError(400, 'Nenhuma linha para lançar.');
  if (entrada.length > 300) throw new HttpError(400, 'Linhas demais de uma vez (máximo de 300).');
  const endereco = U.normEndereco(c.body.endereco);
  if (endereco) { const e = U.erroEndereco(endereco); if (e) throw new HttpError(400, e); }
  const envio = String(c.body.envio || '').slice(0, 64);   // id do envio: reenviar o mesmo lote não duplica (usa client_id)
  const validadas = await validar(c.db, entrada);
  const resultado = { lancadas: 0, falhas: [], avisos: [] };
  for (const [i, v] of validadas.entries()) {
    if (v.bloqueios.length) { resultado.falhas.push({ n: v.n, erro: v.bloqueios.join('; ') }); continue; }
    try {
      const r = await S.leitura(c.db, {
        tipo: 'RECEBIMENTO', ean: v.ean, lote: v.lote, validade: v.validade, qtd: v.qtd,
        endereco, sem_endereco: !endereco, operador: c.operador,
        nome: entrada[i].nome || undefined,
        obs: 'Folha FIFO' + (v.data_lancamento ? ' de ' + U.brData(v.data_lancamento) : ''),
        client_id: envio ? `folha-${envio}-${i}` : undefined,
      });
      if (!r.duplicado) resultado.lancadas++;
      (r.avisos || []).forEach(a => resultado.avisos.push(`Linha ${v.n}: ${a}`));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      resultado.falhas.push({ n: v.n, erro: e.message });
    }
  }
  return resultado;
}

const ROTAS = [
  ['POST', /^\/api\/folha\/ler$/, {}, ler],
  ['POST', /^\/api\/folha\/lancar$/, {}, lancar],
];

module.exports = { ROTAS, LIMITE_CORPO, setExtrator, ler, lancar, MAX_FOTO };
