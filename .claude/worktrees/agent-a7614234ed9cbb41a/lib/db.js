// Camada de banco: PostgreSQL. Produção (Vercel): Neon via DATABASE_URL, com o driver "pg".
// Local e testes: PGlite, um Postgres de verdade rodando dentro do Node (pasta data/pg), sem instalar nada.
// O SQL é o mesmo nos dois, escrito com "?" como parâmetro (convertido para $1, $2… aqui).
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS produtos (
    ean TEXT PRIMARY KEY, ean_key TEXT NOT NULL, nome TEXT, preco DOUBLE PRECISION, custo DOUBLE PRECISION,
    endereco TEXT NOT NULL DEFAULT '', marca TEXT, tipo TEXT, idade TEXT, porte TEXT, categoria TEXT,
    ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS ix_produtos_key ON produtos(ean_key)`,
  // Estoque atual: uma linha por (EAN, lote, validade, endereço). O endereço pertence ao lote, não ao produto.
  `CREATE TABLE IF NOT EXISTS lotes (
    id BIGSERIAL PRIMARY KEY, ean TEXT NOT NULL, lote TEXT NOT NULL, validade TEXT NOT NULL,
    endereco TEXT NOT NULL DEFAULT '', qtd INTEGER NOT NULL DEFAULT 0, acao TEXT, atualizado_em TEXT NOT NULL,
    UNIQUE (ean, lote, validade, endereco))`,
  `CREATE INDEX IF NOT EXISTS ix_lotes_ean ON lotes(ean)`,
  `CREATE INDEX IF NOT EXISTS ix_lotes_end ON lotes(endereco)`,
  // Tudo que acontece vira evento: o estoque é o resultado deles e pode ser auditado.
  `CREATE TABLE IF NOT EXISTS eventos (
    id BIGSERIAL PRIMARY KEY, ts TEXT NOT NULL, tipo TEXT NOT NULL, lote_id BIGINT,
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

// "?" → $1, $2… (ignora o que estiver entre aspas simples)
function pgSql(sql) {
  let n = 0, aspas = false, out = '';
  for (const c of sql) {
    if (c === "'") aspas = !aspas;
    out += c === '?' && !aspas ? '$' + ++n : c;
  }
  return out;
}

const paraNumero = v => Number(v);                    // int8 (COUNT, SUM, BIGSERIAL) vem como texto/BigInt
const OID_INT8 = 20, OID_NUMERIC = 1700;

// exec(sql, params) → { rows, rowCount }
function interface_(exec) {
  const limpa = args => args.map(a => (a === undefined ? null : a));
  return {
    async all(sql, args = []) { return (await exec(pgSql(sql), limpa(args))).rows; },
    async get(sql, args = []) { return (await exec(pgSql(sql), limpa(args))).rows[0] || null; },
    async run(sql, args = []) { return { changes: (await exec(pgSql(sql), limpa(args))).rowCount }; },
    // statements: [[sql, args], ...] — executados em ordem
    async batch(statements) { for (const [sql, args = []] of statements) await exec(pgSql(sql), limpa(args)); },
  };
}

async function abrirPg(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(OID_INT8, paraNumero);
  types.setTypeParser(OID_NUMERIC, parseFloat);
  const pool = new Pool({ connectionString: url, max: +process.env.PG_POOL_MAX || 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  pool.on('error', () => { /* conexão ociosa derrubada pelo servidor; a próxima consulta abre outra */ });
  const exec = alvo => async (sql, p) => { const r = await alvo.query(sql, p); return { rows: r.rows, rowCount: r.rowCount }; };
  const db = interface_(exec(pool));
  db.kind = 'postgres';
  db.close = () => pool.end();
  db.tx = async fn => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(interface_(exec(c)));
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* conexão já caiu */ }
      throw e;
    } finally { c.release(); }
  };
  // criação das tabelas com trava de transação (funciona atrás do pooler do Neon e com várias instâncias subindo juntas)
  await db.tx(async t => {
    await t.get('SELECT pg_advisory_xact_lock(727274)');
    for (const sql of SCHEMA) await t.run(sql);
  });
  return db;
}

async function abrirPglite(dir) {
  const { PGlite } = require('@electric-sql/pglite');
  if (!dir.startsWith('memory:')) fs.mkdirSync(path.dirname(dir), { recursive: true });
  const pg = new PGlite(dir, { parsers: { [OID_INT8]: paraNumero, [OID_NUMERIC]: parseFloat } });
  await pg.waitReady;
  const exec = alvo => async (sql, p) => { const r = await alvo.query(sql, p); return { rows: r.rows, rowCount: r.affectedRows ?? 0 }; };
  const db = interface_(exec(pg));
  db.kind = 'pglite';
  db.close = () => pg.close();
  db.tx = fn => pg.transaction(tx => fn(interface_(exec(tx))));   // o PGlite trava as demais consultas durante a transação
  await db.tx(async t => { for (const sql of SCHEMA) await t.run(sql); });
  return db;
}

async function open(opts = {}) {
  const url = opts.url ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  let db;
  if (url && /^postgres(ql)?:/.test(url)) {
    db = await abrirPg(url);
    db.url = url.replace(/\/\/[^@]*@/, '//***@');
  } else {
    if (process.env.VERCEL) throw new Error('DATABASE_URL não configurado: conecte o banco Neon ao projeto na Vercel (Storage → Neon) ou defina a variável.');
    const dir = opts.dir ?? process.env.PGLITE_DIR ?? path.join(__dirname, '..', 'data', 'pg');
    db = await abrirPglite(dir);
    db.url = 'pglite:' + dir;
  }
  return db;
}

// uma conexão por instância da função (a Vercel reaproveita enquanto a instância está quente)
let compartilhado = null;
function obter() {
  if (!compartilhado) compartilhado = open().catch(e => { compartilhado = null; throw e; });
  return compartilhado;
}

module.exports = { open, obter, pgSql };
