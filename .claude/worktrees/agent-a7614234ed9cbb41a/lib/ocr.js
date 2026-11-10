'use strict';
// Adaptador de leitura da folha por visão (Anthropic Messages API). O OCR só PROPÕE linhas; quem grava é a pessoa, na confirmação.
const { HttpError } = require('./util');

const MODELO = 'claude-sonnet-5-5';
const URL_API = 'https://api.anthropic.com/v1/messages';
const MSG_SEM_CHAVE = 'Leitura de foto ainda não configurada: falta a chave ANTHROPIC_API_KEY no servidor';

const PROMPT = `Esta é a foto de uma folha manuscrita de controle de validade (FIFO) de uma loja. As colunas são: DATA DE LANÇAMENTO, COD. EAN, LOTE, VALIDADE, QUANT.
Transcreva CADA linha preenchida, de cima para baixo, como JSON estrito, sem texto fora do JSON, neste formato:
{"linhas":[{"data_lancamento":"dd/mm/aa","ean":"7896181297840","lote":"1130","validade":"16/07/26","qtd":1}]}
Regras:
- Copie exatamente o que está escrito; NÃO corrija, NÃO adivinhe e NÃO invente dígitos. Se um campo estiver ilegível, devolva "" (ou null em qtd).
- A data de lançamento costuma aparecer só na primeira linha; se uma linha não tiver, devolva "".
- ean: só dígitos (normalmente 13). lote: texto como escrito. validade: dd/mm/aa. qtd: número inteiro.
- Ignore risquinhos na margem direita, cabeçalho e rodapé (responsável, ciente).`;

function extrairJson(texto) {
  const t = String(texto || '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < i) throw new HttpError(502, 'A leitura da foto não devolveu dados. Tente outra foto, mais nítida e de frente.');
  let o;
  try { o = JSON.parse(t.slice(i, j + 1)); } catch { throw new HttpError(502, 'A leitura da foto veio em formato inesperado. Tente de novo.'); }
  const linhas = Array.isArray(o) ? o : o.linhas;
  if (!Array.isArray(linhas)) throw new HttpError(502, 'A leitura da foto veio em formato inesperado. Tente de novo.');
  return linhas.filter(l => l && typeof l === 'object').map(l => ({
    data_lancamento: l.data_lancamento ?? '', ean: l.ean ?? '', lote: l.lote ?? '', validade: l.validade ?? '', qtd: l.qtd ?? '',
  }));
}

// "data:image/jpeg;base64,..." -> { mediaType, base64 }
function lerDataUrl(s) {
  const m = String(s || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw new HttpError(400, 'Envie a foto como imagem JPEG ou PNG.');
  return { mediaType: m[1], base64: m[2].replace(/\s+/g, '') };
}

// `http` é injetável: async (url, init) => resposta com {ok, status, json()}. Os testes nunca vão à rede.
function criarExtrator({ http = (u, i) => fetch(u, i), chave = () => process.env.ANTHROPIC_API_KEY, modelo = MODELO } = {}) {
  return async function extrair(dataUrl) {
    const key = chave();
    if (!key) throw new HttpError(503, MSG_SEM_CHAVE);
    const { mediaType, base64 } = lerDataUrl(dataUrl);
    let r;
    try {
      r = await http(URL_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: modelo, max_tokens: 8000,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: PROMPT },
          ] }],
        }),
      });
    } catch { throw new HttpError(502, 'Não consegui falar com o serviço de leitura de fotos. Tente de novo em instantes.'); }
    if (!r.ok) {
      console.error('[folha] API de visão respondeu', r.status);
      throw new HttpError(502, r.status === 401 ? 'A chave ANTHROPIC_API_KEY do servidor foi recusada.' : `O serviço de leitura de fotos respondeu com erro (${r.status}). Tente de novo.`);
    }
    const j = await r.json();
    const texto = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return extrairJson(texto);
  };
}

module.exports = { criarExtrator, extrairJson, lerDataUrl, MODELO, MSG_SEM_CHAVE };
