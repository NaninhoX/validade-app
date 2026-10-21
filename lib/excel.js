const ExcelJS = require('exceljs');
const U = require('./util');
const S = require('./service');

const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// valor de célula já "resolvido" (fórmula → resultado)
function val(cell) {
  let v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if ('richText' in v) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;
    else return null;
    if (v && typeof v === 'object' && !(v instanceof Date)) return null; // #VALUE! etc.
  }
  if (typeof v === 'string' && /^⚠️|^#/.test(v)) return null; // "EAN não cadastrado", erros
  return v === '' ? null : v;
}

function achaAba(wb, ...nomes) {
  const alvo = nomes.map(semAcento);
  return wb.worksheets.find(ws => alvo.includes(semAcento(ws.name)));
}

// Encontra a linha de cabeçalho nas 12 primeiras linhas e mapeia colunas por nome.
function cabecalho(ws, obrigatorias) {
  for (let r = 1; r <= 12; r++) {
    const m = {};
    ws.getRow(r).eachCell((c, col) => {
      const t = semAcento(val(c));
      if (t) m[t] = m[t] || col;
    });
    if (obrigatorias.every(k => m[k])) return { linha: r, col: m };
  }
  return null;
}

const pegar = (m, ...nomes) => { for (const n of nomes) if (m[n]) return m[n]; return null; };
const txt = v => (v === null || v === undefined ? null : String(v).trim() || null);
const num = v => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const meioDia = d => `${d}T12:00:00.000Z`;

async function importar(db, arquivoOuBuffer, { substituir = false } = {}) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(arquivoOuBuffer)) await wb.xlsx.load(arquivoOuBuffer);
  else await wb.xlsx.readFile(arquivoOuBuffer);

  const rel = { produtos: 0, lotes: 0, lotes_agrupados: 0, baixas_historico: 0, recebimentos_historico: 0, ignoradas: [], avisos: [] };
  const wsProd = achaAba(wb, 'Produtos');
  const wsFifo = achaAba(wb, 'FIFO', 'Estoque');
  const wsHist = achaAba(wb, 'Historico');
  const wsRec = achaAba(wb, 'Recebimento');
  if (!wsProd && !wsFifo) throw new U.HttpError(400, 'o arquivo não tem aba "Produtos" nem "FIFO"/"Estoque"');

  // ---- 1) lê tudo da planilha (sem tocar no banco) ----
  const produtos = [];
  if (wsProd) {
    const h = cabecalho(wsProd, ['codigo', 'nome']);
    if (!h) rel.avisos.push('Produtos: cabeçalho não encontrado');
    else {
      const c = h.col;
      const cols = {
        ean: pegar(c, 'codigo'), nome: pegar(c, 'nome', 'nome do produto'), preco: pegar(c, 'preco r', 'preco'), end: pegar(c, 'endereco'),
        marca: pegar(c, 'marca'), tipo: pegar(c, 'tipo'), idade: pegar(c, 'idade'), porte: pegar(c, 'porte'), cat: pegar(c, 'categoria'),
      };
      for (let r = h.linha + 1; r <= wsProd.rowCount; r++) {
        const row = wsProd.getRow(r);
        const ean = U.normEan(val(row.getCell(cols.ean)));
        if (!ean) continue;
        const g = k => (cols[k] ? txt(val(row.getCell(cols[k]))) : null);
        produtos.push([ean, U.eanKey(ean), txt(val(row.getCell(cols.nome))), cols.preco ? num(val(row.getCell(cols.preco))) : null,
          U.normEndereco(g('end')), g('marca'), g('tipo'), g('idade'), g('porte'), g('cat')]);
      }
    }
  }

  const fifo = new Map(); // ean|lote|validade|endereco → linha agregada
  const fifoNomes = new Map();
  if (wsFifo) {
    const h = cabecalho(wsFifo, ['codigo', 'lote', 'validade']);
    if (!h) rel.avisos.push('FIFO: cabeçalho (Código, Lote, Validade) não encontrado');
    else {
      const c = h.col;
      const k = {
        ean: pegar(c, 'codigo'), nome: pegar(c, 'nome do produto', 'nome'), lote: pegar(c, 'lote'), qtd: pegar(c, 'qtd', 'quantidade'),
        preco: pegar(c, 'preco r', 'preco'), val: pegar(c, 'validade'), end: pegar(c, 'endereco'), atual: pegar(c, 'ultima atualizacao'), acao: pegar(c, 'acao tomada'),
      };
      for (let r = h.linha + 1; r <= wsFifo.rowCount; r++) {
        const row = wsFifo.getRow(r);
        const ean0 = U.normEan(val(row.getCell(k.ean)));
        if (!ean0) continue;
        const validade = U.parseData(val(row.getCell(k.val)));
        if (!validade) { rel.ignoradas.push(`FIFO linha ${r}: validade inválida`); continue; }
        const qtd = Math.round(num(val(row.getCell(k.qtd))) ?? 0);
        if (qtd <= 0) { rel.ignoradas.push(`FIFO linha ${r}: quantidade ${qtd}`); continue; }
        const lote = U.normLote(val(row.getCell(k.lote)));
        const endereco = U.normEndereco(k.end ? val(row.getCell(k.end)) : '');
        const dataAtual = k.atual ? U.parseData(val(row.getCell(k.atual))) : null;
        const ts = dataAtual ? meioDia(dataAtual) : U.agoraISO();
        const chave = [ean0, lote, validade, endereco].join('|');
        const ex = fifo.get(chave);
        if (ex) { ex.qtd += qtd; if (ts > ex.ts) ex.ts = ts; rel.lotes_agrupados++; }
        else fifo.set(chave, { ean: ean0, lote, validade, endereco, qtd, ts, acao: k.acao ? txt(val(row.getCell(k.acao))) : null,
          preco: k.preco ? num(val(row.getCell(k.preco))) : null, nome: k.nome ? txt(val(row.getCell(k.nome))) : null, linha: r });
      }
    }
  }

  const baixas = [];
  if (wsHist) {
    const h = cabecalho(wsHist, ['codigo', 'qtd']);
    if (h) {
      const c = h.col;
      const k = { ean: pegar(c, 'codigo'), lote: pegar(c, 'lote'), qtd: pegar(c, 'qtd'), val: pegar(c, 'validade'), end: pegar(c, 'endereco'), data: pegar(c, 'data da remocao'), motivo: pegar(c, 'motivo da remocao') };
      for (let r = h.linha + 1; r <= wsHist.rowCount; r++) {
        const row = wsHist.getRow(r);
        const ean = U.normEan(val(row.getCell(k.ean)));
        const qtd = Math.round(num(val(row.getCell(k.qtd))) ?? 0);
        if (!ean || qtd <= 0) continue;
        const d = k.data ? U.parseData(val(row.getCell(k.data))) : null;
        baixas.push({ r, ts: d ? meioDia(d) : U.agoraISO(), ean, lote: U.normLote(val(row.getCell(k.lote))), validade: U.parseData(val(row.getCell(k.val))),
          endereco: U.normEndereco(k.end ? val(row.getCell(k.end)) : ''), qtd, motivo: (k.motivo && txt(val(row.getCell(k.motivo)))) || 'Vencido' });
      }
    }
  }

  const recebs = [];
  if (wsRec) {
    const h = cabecalho(wsRec, ['data', 'codigo', 'qtd']);
    if (h) {
      const c = h.col;
      const k = { data: pegar(c, 'data'), ean: pegar(c, 'codigo'), lote: pegar(c, 'lote'), qtd: pegar(c, 'qtd'), val: pegar(c, 'validade') };
      for (let r = h.linha + 1; r <= wsRec.rowCount; r++) {
        const row = wsRec.getRow(r);
        const ean = U.normEan(val(row.getCell(k.ean)));
        const qtd = Math.round(num(val(row.getCell(k.qtd))) ?? 0);
        const d = U.parseData(val(row.getCell(k.data)));
        if (!ean || qtd <= 0 || !d) continue;
        recebs.push({ r, ts: meioDia(d), ean, lote: U.normLote(val(row.getCell(k.lote))), validade: U.parseData(val(row.getCell(k.val))), qtd });
      }
    }
  }

  // ---- 2) grava tudo numa transação (inserções em bloco: poucos idas e vindas ao banco, mesmo remoto) ----
  const em = (itens, n) => { const r = []; for (let i = 0; i < itens.length; i += n) r.push(itens.slice(i, i + n)); return r; };
  const multi = (cabeca, ph, linhas, n, sufixo = '') => em(linhas, n).map(g => [`${cabeca} VALUES ${g.map(() => ph).join(',')}${sufixo}`, g.flat()]);

  // mesmo EAN repetido na aba Produtos: mescla (o último valor preenchido vence) — o Postgres não aceita a mesma chave duas vezes no mesmo INSERT
  const prodMap = new Map();
  for (const p of produtos) {
    const ex = prodMap.get(p[0]);
    if (!ex) prodMap.set(p[0], p.slice());
    else for (let i = 2; i < p.length; i++) if (p[i] !== null && p[i] !== '') ex[i] = p[i];
  }

  await db.tx(async t => {
    const existentes = (await t.get('SELECT COUNT(*) n FROM lotes')).n;
    if (existentes && !substituir) throw new U.HttpError(409, `já existem ${existentes} lotes no banco; use a opção de substituir`);
    if (substituir) {
      await t.run('DELETE FROM eventos');
      await t.run('DELETE FROM lotes');
      if (wsProd) await t.run('DELETE FROM produtos');
    }

    await t.batch(multi('INSERT INTO produtos(ean,ean_key,nome,preco,endereco,marca,tipo,idade,porte,categoria)', '(?,?,?,?,?,?,?,?,?,?)', [...prodMap.values()].map(p => [p[0], p[1], p[2], p[3], p[4] ?? '', p[5], p[6], p[7], p[8], p[9]]), 400,
      ` ON CONFLICT (ean) DO UPDATE SET nome=COALESCE(EXCLUDED.nome, produtos.nome), preco=COALESCE(EXCLUDED.preco, produtos.preco),
        endereco=CASE WHEN EXCLUDED.endereco<>'' THEN EXCLUDED.endereco ELSE produtos.endereco END, marca=COALESCE(EXCLUDED.marca, produtos.marca),
        tipo=COALESCE(EXCLUDED.tipo, produtos.tipo), idade=COALESCE(EXCLUDED.idade, produtos.idade), porte=COALESCE(EXCLUDED.porte, produtos.porte),
        categoria=COALESCE(EXCLUDED.categoria, produtos.categoria)`));
    rel.produtos = prodMap.size;

    const conhecidos = new Map();                       // ean_key → ean
    for (const p of await t.all('SELECT ean, ean_key FROM produtos')) conhecidos.set(p.ean_key, p.ean);
    const resolve = ean => conhecidos.get(U.eanKey(ean)) || ean;

    const novosProdutos = [], ajustes = new Map(), lotesIns = [], evIns = [];
    for (const l of fifo.values()) {
      const ean = resolve(l.ean);
      if (!conhecidos.has(U.eanKey(ean))) {
        conhecidos.set(U.eanKey(ean), ean);
        novosProdutos.push([ean, U.eanKey(ean), l.nome]);
        if (wsProd) rel.avisos.push(`EAN ${ean} não está em Produtos (linha ${l.linha})`);
      }
      if (l.preco !== null || l.endereco) {
        const a = ajustes.get(ean) || { preco: null, endereco: '' };
        if (a.preco === null && l.preco !== null) a.preco = l.preco;
        if (!a.endereco && l.endereco) a.endereco = l.endereco;
        ajustes.set(ean, a);
      }
      lotesIns.push([ean, l.lote, l.validade, l.endereco, l.qtd, l.acao, l.ts]);
      evIns.push([l.ts, ean, l.lote, l.validade, l.endereco, ean, l.lote, l.validade, l.endereco, l.qtd, l.qtd, `imp-${ean}-${l.lote}-${l.validade}-${l.endereco}`]);
      rel.lotes++;
    }
    await t.batch([
      ...multi('INSERT INTO produtos(ean,ean_key,nome)', '(?,?,?)', novosProdutos, 400, ' ON CONFLICT (ean) DO NOTHING'),
      ...em([...ajustes].map(([ean, a]) => [ean, a.preco, a.endereco]), 400).map(g => [
        `UPDATE produtos AS p SET preco = COALESCE(p.preco, v.preco), endereco = CASE WHEN p.endereco = '' THEN v.endereco ELSE p.endereco END
         FROM (VALUES ${g.map(() => '(?::text, ?::float8, ?::text)').join(',')}) AS v(ean, preco, endereco) WHERE p.ean = v.ean`, g.flat()]),
      ...multi('INSERT INTO lotes(ean,lote,validade,endereco,qtd,acao,atualizado_em)', '(?,?,?,?,?,?,?)', lotesIns, 300),
      ...multi('INSERT INTO eventos(ts,tipo,lote_id,ean,lote,validade,endereco,delta,qtd_antes,qtd_depois,operador,motivo,grupo)',
        "(?,'IMPORT',(SELECT id FROM lotes WHERE ean=? AND lote=? AND validade=? AND endereco=?),?,?,?,?,?,0,?,'importação','Carga inicial da planilha',?)", evIns, 150),
      ...multi('INSERT INTO eventos(ts,tipo,ean,lote,validade,endereco,delta,operador,motivo,grupo,historico)', "(?,'BAIXA',?,?,?,?,?,'histórico',?,?,1)",
        baixas.map(b => [b.ts, resolve(b.ean), b.lote, b.validade, b.endereco, -b.qtd, b.motivo, `hist-${b.r}`]), 300),
      ...multi('INSERT INTO eventos(ts,tipo,ean,lote,validade,endereco,delta,operador,motivo,grupo,historico)', "(?,'RECEBIMENTO',?,?,?,'',?,'histórico','Recebimento da planilha antiga',?,1)",
        recebs.map(r => [r.ts, resolve(r.ean), r.lote, r.validade, r.qtd, `rec-${r.r}`]), 300),
    ]);
    rel.baixas_historico = baixas.length;
    rel.recebimentos_historico = recebs.length;
    await t.run("INSERT INTO usuarios(nome, papel, criado_em) VALUES('MICHEL','admin',?) ON CONFLICT (nome) DO NOTHING", [U.agoraISO()]);
  });
  return rel;
}

// ---------- exportação ----------
const COR_STATUS = { Vencido: 'FF9F1239', Urgente: 'FFE11D48', 'Alerta 30d': 'FFF97316', 'Alerta 60d': 'FFCA8A04', 'Alerta 90d': 'FF3B82F6', Atenção: 'FF06B6D4', OK: 'FF22C55E' };

function cabecalhoEstilo(ws, linha = 1) {
  const r = ws.getRow(linha);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  r.alignment = { vertical: 'middle' };
  r.height = 22;
}

async function exportar(db) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Controle de Validade';
  wb.created = new Date();
  const [lotes, fila, evs, baixasEv, r] = await Promise.all([
    S.lotesAtivos(db), S.fila(db, 500), S.eventos(db, { limite: 2000 }), S.eventos(db, { limite: 2000, tipo: 'BAIXA' }), S.resumo(db),
  ]);
  const asDate = iso => (iso ? new Date(iso + 'T00:00:00Z') : null);
  const local = ts => U.relogioLoja(ts);

  // Estoque (mesmas colunas do FIFO original, para reimportar sem esforço)
  const ws = wb.addWorksheet('Estoque', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Código', key: 'ean', width: 16 }, { header: 'Nome do Produto', key: 'nome', width: 58 }, { header: 'Lote', key: 'lote', width: 14 },
    { header: 'Qtd', key: 'qtd', width: 7 }, { header: 'Preço (R$)', key: 'preco', width: 11, style: { numFmt: '#,##0.00' } },
    { header: 'Validade', key: 'validade', width: 12, style: { numFmt: 'dd/mm/yyyy' } }, { header: 'Endereço', key: 'endereco', width: 11 },
    { header: 'Gôndola', key: 'gondola', width: 9 }, { header: 'Última Atualização', key: 'atual', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    { header: 'Dias p/Vencer', key: 'dias', width: 13 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Desconto', key: 'desc', width: 9 },
    { header: 'Ação Tomada', key: 'acao', width: 16 }, { header: 'Estratégia Venda', key: 'estrategia', width: 18 },
    { header: 'Perda Potencial', key: 'perda', width: 14, style: { numFmt: '#,##0.00' } }, { header: 'Marca', key: 'marca', width: 14 },
  ];
  cabecalhoEstilo(ws);
  lotes.forEach(l => {
    const row = ws.addRow({
      ean: l.ean, nome: l.nome, lote: l.lote, qtd: l.qtd, preco: l.preco, validade: asDate(l.validade), endereco: l.endereco, gondola: l.gondola,
      atual: local(l.atualizado_em), dias: l.dias, status: l.status, desc: l.desconto ? l.desconto / 100 : 0, acao: l.acao, estrategia: l.estrategia,
      perda: l.perda === null ? null : -l.perda, marca: l.marca,
    });
    row.getCell('desc').numFmt = '0%';
    row.getCell('ean').numFmt = '@';
    const cor = COR_STATUS[l.status];
    if (cor) { row.getCell('status').font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cor } }; }
  });
  ws.autoFilter = { from: 'A1', to: 'P1' };

  const wf = wb.addWorksheet('Fazer hoje', { views: [{ state: 'frozen', ySplit: 1 }] });
  wf.columns = [
    { header: 'Status', key: 'status', width: 12 }, { header: 'Ação sugerida', key: 'acao', width: 38 }, { header: 'Código', key: 'ean', width: 16 },
    { header: 'Produto', key: 'nome', width: 58 }, { header: 'Lote', key: 'lote', width: 12 }, { header: 'Qtd', key: 'qtd', width: 6 },
    { header: 'Validade', key: 'validade', width: 12, style: { numFmt: 'dd/mm/yyyy' } }, { header: 'Dias', key: 'dias', width: 7 },
    { header: 'Endereço', key: 'endereco', width: 10 }, { header: 'Valor em risco', key: 'valor', width: 14, style: { numFmt: '#,##0.00' } },
  ];
  cabecalhoEstilo(wf);
  fila.forEach(l => wf.addRow({ status: l.status, acao: l.acao_sugerida, ean: l.ean, nome: l.nome, lote: l.lote, qtd: l.qtd, validade: asDate(l.validade), dias: l.dias, endereco: l.endereco, valor: l.valor }));
  wf.getColumn('ean').numFmt = '@';

  const wbx = wb.addWorksheet('Baixas', { views: [{ state: 'frozen', ySplit: 1 }] });
  wbx.columns = [
    { header: 'Data', key: 'ts', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { header: 'Código', key: 'ean', width: 16 }, { header: 'Produto', key: 'nome', width: 58 },
    { header: 'Lote', key: 'lote', width: 12 }, { header: 'Validade', key: 'validade', width: 12, style: { numFmt: 'dd/mm/yyyy' } }, { header: 'Qtd', key: 'qtd', width: 6 },
    { header: 'Endereço', key: 'endereco', width: 10 }, { header: 'Motivo', key: 'motivo', width: 20 }, { header: 'Operador', key: 'operador', width: 14 }, { header: 'Causa', key: 'causa', width: 30 },
  ];
  cabecalhoEstilo(wbx);
  baixasEv.filter(e => !e.desfeito).forEach(e => wbx.addRow({ ts: local(e.ts), ean: e.ean, nome: e.nome, lote: e.lote, validade: asDate(e.validade), qtd: -e.delta, endereco: e.endereco, motivo: e.motivo, operador: e.operador, causa: e.causa }));
  wbx.getColumn('ean').numFmt = '@';

  const we = wb.addWorksheet('Movimentações', { views: [{ state: 'frozen', ySplit: 1 }] });
  we.columns = [
    { header: 'Data', key: 'ts', width: 18, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { header: 'Tipo', key: 'tipo', width: 15 }, { header: 'Código', key: 'ean', width: 16 },
    { header: 'Produto', key: 'nome', width: 50 }, { header: 'Lote', key: 'lote', width: 12 }, { header: 'Endereço', key: 'endereco', width: 10 },
    { header: 'Δ Qtd', key: 'delta', width: 8 }, { header: 'Antes', key: 'antes', width: 8 }, { header: 'Depois', key: 'depois', width: 8 },
    { header: 'Operador', key: 'operador', width: 14 }, { header: 'Motivo', key: 'motivo', width: 22 }, { header: 'Causa', key: 'causa', width: 30 }, { header: 'Desfeito', key: 'desfeito', width: 9 },
  ];
  cabecalhoEstilo(we);
  evs.forEach(e => we.addRow({ ts: local(e.ts), tipo: e.tipo, ean: e.ean, nome: e.nome, lote: e.lote, endereco: e.endereco, delta: e.delta,
    antes: e.qtd_antes, depois: e.qtd_depois, operador: e.operador, motivo: e.motivo, causa: e.causa, desfeito: e.desfeito ? 'sim' : '' }));
  we.getColumn('ean').numFmt = '@';

  const wr = wb.addWorksheet('Resumo');
  wr.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 18 }];
  wr.addRow(['Controle de Validade — resumo']).font = { bold: true, size: 14 };
  wr.addRow(['Gerado em', local(new Date())]).getCell(2).numFmt = 'dd/mm/yyyy hh:mm';
  wr.addRow([]);
  wr.addRow(['Total de lotes', r.totais.lotes]); wr.addRow(['Produtos distintos', r.totais.produtos]); wr.addRow(['Itens em estoque', r.totais.itens]);
  wr.addRow(['Valor em estoque (R$)', r.totais.valor]).getCell(2).numFmt = '#,##0.00';
  wr.addRow(['Valor em risco (R$)', r.totais.valor_em_risco]).getCell(2).numFmt = '#,##0.00';
  wr.addRow(['Perda potencial (R$)', r.totais.perda_potencial]).getCell(2).numFmt = '#,##0.00';
  wr.addRow([]);
  wr.addRow(['Status', 'Lotes', 'Itens', 'Valor (R$)', 'Perda potencial (R$)']).font = { bold: true };
  r.por_status.forEach(s => { const x = wr.addRow([s.status, s.lotes, s.qtd, s.valor, s.perda]); x.getCell(4).numFmt = '#,##0.00'; x.getCell(5).numFmt = '#,##0.00'; });
  wr.addRow([]);
  wr.addRow(['Qualidade dos dados']).font = { bold: true };
  wr.addRow(['Lotes sem preço', r.qualidade.sem_preco]); wr.addRow(['Lotes sem endereço', r.qualidade.sem_endereco]);
  wr.addRow(['Lotes com endereço fora do padrão', r.qualidade.endereco_fora_padrao]);
  wr.addRow(['Lotes de EAN não cadastrado', r.qualidade.sem_cadastro]); wr.addRow(['Vencidos ainda no estoque', r.qualidade.vencidos_em_estoque]);

  return wb.xlsx.writeBuffer();
}

module.exports = { importar, exportar };
