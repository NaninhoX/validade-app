// Migração única: nas gôndolas 11 a 18 os lados A e B foram contados com a convenção contrária à do mapa
// (agora A é sempre a metade de baixo e B a de cima). Troca A↔B nos endereços dos lotes e do histórico.
// Frente/Costas não mudam. Lotes que acabarem no mesmo endereço (mesmo EAN, lote e validade) são somados.
const U = require('./util');

const DE_ATE = [11, 18];
const re = /^(\d{1,2})-([AB])-(\d{1,2})$/;
const troca = e => {
  const m = String(e || '').match(re);
  if (!m || +m[1] < DE_ATE[0] || +m[1] > DE_ATE[1]) return null;
  return `${m[1]}-${m[2] === 'A' ? 'B' : 'A'}-${m[3]}`;
};

async function inverterLados(db) {
  return db.tx(async t => {
    const feito = await t.get("SELECT valor FROM config WHERE chave='migracao_ab_11_18'");
    if (feito) return { ja_feita: true, quando: JSON.parse(feito.valor).quando };
    const lotes = (await t.all('SELECT id, ean, lote, validade, endereco, qtd FROM lotes ORDER BY id')).filter(l => troca(l.endereco));
    // 1) tira os afetados do caminho (endereço provisório único por id) para não bater na chave única durante a troca
    for (const l of lotes) await t.run('UPDATE lotes SET endereco=? WHERE id=?', [`TMP-${l.id}`, l.id]);
    // 2) agrupa pelo endereço novo e soma quando coincidir
    const grupos = new Map();
    for (const l of lotes) {
      const novo = troca(l.endereco), k = `${l.ean}|${l.lote}|${l.validade}|${novo}`;
      (grupos.get(k) || grupos.set(k, []).get(k)).push({ ...l, novo });
    }
    let somados = 0;
    for (const g of grupos.values()) {
      const [fica, ...outros] = g;
      let qtd = fica.qtd;
      for (const o of outros) {
        qtd += o.qtd; somados++;
        await t.run('UPDATE eventos SET lote_id=? WHERE lote_id=?', [fica.id, o.id]);
        await t.run('DELETE FROM lotes WHERE id=?', [o.id]);
      }
      await t.run('UPDATE lotes SET endereco=?, qtd=? WHERE id=?', [fica.novo, qtd, fica.id]);
    }
    // 3) histórico: endereço do evento e, nas transferências, o endereço guardado no motivo
    let eventos = 0;
    for (const e of await t.all('SELECT id, endereco, tipo, motivo FROM eventos')) {
      const ne = troca(e.endereco), nm = e.tipo.startsWith('TRANSF') ? troca(e.motivo) : null;
      if (!ne && !nm) continue;
      await t.run('UPDATE eventos SET endereco=COALESCE(?, endereco), motivo=COALESCE(?, motivo) WHERE id=?', [ne, nm, e.id]);
      eventos++;
    }
    // 4) responsáveis/nomes de lado já configurados nessas gôndolas também trocam de lado
    const cfg = await t.get("SELECT valor FROM config WHERE chave='setores'");
    if (cfg) {
      const s = JSON.parse(cfg.valor);
      for (const g of Object.keys(s)) if (+g >= DE_ATE[0] && +g <= DE_ATE[1]) { const { A, B, ...resto } = s[g]; s[g] = { ...resto, ...(B ? { A: B } : {}), ...(A ? { B: A } : {}) }; }
      await t.run("UPDATE config SET valor=? WHERE chave='setores'", [JSON.stringify(s)]);
    }
    const r = { ja_feita: false, lotes: lotes.length, somados, eventos, quando: U.agoraISO() };
    await t.run("INSERT INTO config(chave,valor) VALUES('migracao_ab_11_18', ?)", [JSON.stringify(r)]);
    return r;
  });
}

module.exports = { inverterLados, troca };
