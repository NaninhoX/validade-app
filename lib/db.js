// Camada de banco sobre libSQL (SQLite). Local: arquivo data/validade.db. Vercel: Turso via TURSO_DATABASE_URL.
const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS produtos (
    ean TEXT PRIMARY KEY, ean_key TEXT NOT NULL, nome TEXT, preco REAL, custo REAL,
    endereco TEXT NOT NULL DEFAULT '', marca TEXT, tipo TEXT, idade TEXT, porte TEXT, categoria TEXT,
    ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS ix_produtos_key ON produtos(ean_key)`,
  // Estoque atual: uma linha por (EAN, lote, validade, endereço). O endereço pertence ao lote, não ao produto.
  `CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ean TEXT NOT NULL, lote TEXT NOT NULL, validade TEXT NOT NULL,
    endereco TEXT NOT NULL DEFAULT '', qtd INTEGER NOT NULL DEFAULT 0, acao TEXT, atualizado_em TEXT NOT NULL,
    UNIQUE (ean, lote, validade, endereco))`,
  `CREATE INDEX IF NOT EXISTS ix_lotes_ean ON lotes(ean)`,
  `CREATE INDEX IF NOT EXISTS ix_lotes_end ON lotes(endereco)`,
  // Tudo que acontece vira evento: o estoque é o resultado deles e pode ser auditado.
  `CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, tipo TEXT NOT NULL, lote_id INTEGER,
    ean TEXT NOT NULL, lote TEXT, validade TEXT, endereco TEXT, delta INTEGER NOT NULL DEFAULT 0,
    qtd_antes INTEGER, qtd_depois INTEGER, operador TEXT, motivo TEXT, obs TEXT,
    client_id TEXT UNIQUE, grupo TEXT, desfeito INTEGER NOT NULL DEFAULT 0, historico INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_ev_ts ON eventos(ts)`,
  `CREATE INDEX IF NOT EXISTS ix_ev_ean ON eventos(ean)`,
  `CREATE INDEX IF NOT EXISTS ix_ev_grupo ON eventos(grupo)`,
  `CREATE TABLE IF NOT EXISTS usuarios (
    nome TEXT PRIMARY KEY, papel TEXT NOT NULL DEFAULT 'operador', pin_hash TEXT, salt TEXT,
    ativo INTEGER NOT NULL DEFAULT 1, falhas INTEGER NOT NULL DEFAULT 0, bloqueado_ate TEXT, criado_em TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
];

function urlPadrao() {
  const p = path.join(__dirname, '..', 'data', 'validade.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return 'file:' + p.replace(/\\/g, '/');
}

const objs = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

// Mesma interface no cliente e dentro de uma transação.
function api(alvo, batchFn) {
  return {
    async all(sql, args = []) { return objs(await alvo.execute({ sql, args })); },
    async get(sql, args = []) { return objs(await alvo.execute({ sql, args }))[0] || null; },
    async run(sql, args = []) {
      const rs = await alvo.execute({ sql, args });
      return { changes: rs.rowsAffected, id: rs.lastInsertRowid === undefined ? null : Number(rs.lastInsertRowid) };
    },
    // statements: [[sql, args], ...] — em lotes, bem mais rápido que um por um quando o banco é remoto
    async batch(statements) {
      for (let i = 0; i < statements.length; i += 400)
        await batchFn(statements.slice(i, i + 400).map(([sql, args = []]) => ({ sql, args })));
    },
  };
}

async function open(opts = {}) {
  const url = opts.url || process.env.TURSO_DATABASE_URL || urlPadrao();
  const client = createClient({ url, authToken: opts.authToken || process.env.TURSO_AUTH_TOKEN || undefined });
  const db = api(client, stmts => client.batch(stmts, 'write'));
  db.url = url;
  db.close = () => client.close();
  db.tx = async fn => {
    const t = await client.transaction('write');
    try {
      const r = await fn(api(t, stmts => t.batch(stmts)));
      await t.commit();
      return r;
    } catch (e) {
      try { await t.rollback(); } catch { /* já revertida */ }
      throw e;
    } finally {
      t.close();
    }
  };
  if (url.startsWith('file:')) { try { await client.execute('PRAGMA journal_mode = WAL'); } catch { /* ok */ } }
  await client.batch(SCHEMA.map(sql => ({ sql, args: [] })), 'write');
  return db;
}

// uma conexão por instância da função (a Vercel reaproveita enquanto a instância está quente)
let compartilhado = null;
function obter() {
  if (!compartilhado) compartilhado = open().catch(e => { compartilhado = null; throw e; });
  return compartilhado;
}

module.exports = { open, obter };
