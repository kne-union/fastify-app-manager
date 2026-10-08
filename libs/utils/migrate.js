const path = require('node:path');
const fs = require('fs-extra');
const { listSqlFiles } = require('./validatePackage');

const SQL_MIGRATIONS_TABLE = '_fs_sql_migrations';
const MIGRATION_ACTIONS = ['execute', 'skip', 'hold'];
const SQL_FILE_NAME_RE = /^[A-Za-z0-9_\-.]+\.sql$/;

const isValidSqlFileName = name => typeof name === 'string' && SQL_FILE_NAME_RE.test(name) && !name.includes('..');

const ensureMigrationsTable = sequelize =>
  // TIMESTAMP is portable across sqlite / postgres / mysql (avoid DATETIME — missing on PG)
  sequelize.query(
    `CREATE TABLE IF NOT EXISTS ${SQL_MIGRATIONS_TABLE} (
        name VARCHAR(255) PRIMARY KEY,
        executed_at TIMESTAMP
      )`
  );

const readExecutedMigrations = async sequelize => {
  await ensureMigrationsTable(sequelize);
  const [rows] = await sequelize.query(`SELECT name, executed_at FROM ${SQL_MIGRATIONS_TABLE}`);
  return new Map((rows || []).map(r => [r.name, r.executed_at || null]));
};

const recordMigration = async (sequelize, name) => {
  await ensureMigrationsTable(sequelize);
  await sequelize.query(`DELETE FROM ${SQL_MIGRATIONS_TABLE} WHERE name = ?`, { replacements: [name] });
  await sequelize.query(`INSERT INTO ${SQL_MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`, {
    replacements: [name, new Date().toISOString()]
  });
};

const removeMigrationRecord = async (sequelize, name) => {
  await ensureMigrationsTable(sequelize);
  await sequelize.query(`DELETE FROM ${SQL_MIGRATIONS_TABLE} WHERE name = ?`, { replacements: [name] });
};

/**
 * Run .sql files under server/{sqlPath} with the same tracking semantics as @kne/fastify-sequelize.
 * actions: { [file]: 'execute' | 'skip' | 'hold' } for pending files; missing entries default to 'execute'.
 * skip records the file as executed without running it (so the child app won't run it on sync either);
 * hold leaves it pending.
 */
const runSqlMigrations = async ({ serverDir, sqlPath = 'sql', env = {}, Sequelize: SequelizeCtor, actions = {} } = {}) => {
  const sqlDir = path.join(serverDir, sqlPath);
  const files = await listSqlFiles(sqlDir);
  if (!files.length) {
    return { executed: [], marked: [], held: [], skipped: true };
  }

  const sequelize = createSequelizeFromEnv(env, SequelizeCtor);
  try {
    await sequelize.authenticate();
    const done = await readExecutedMigrations(sequelize);
    const executed = [];
    const marked = [];
    const held = [];

    for (const file of files) {
      if (done.has(file)) {
        continue;
      }
      const action = actions[file] || 'execute';
      if (action === 'hold') {
        held.push(file);
        continue;
      }
      if (action === 'skip') {
        await recordMigration(sequelize, file);
        marked.push(file);
        continue;
      }
      const sql = await fs.readFile(path.join(sqlDir, file), 'utf8');
      await sequelize.query(sql);
      await recordMigration(sequelize, file);
      executed.push(file);
    }
    return { executed, marked, held, skipped: false };
  } finally {
    await sequelize.close();
  }
};

const createSequelizeFromEnv = (env, SequelizeCtor) => {
  let Sequelize = SequelizeCtor;
  if (typeof Sequelize !== 'function') {
    const mod = require('sequelize');
    Sequelize = typeof mod === 'function' ? mod : mod.Sequelize;
  }
  const dialect = env.DB_DIALECT || 'sqlite';
  if (dialect === 'sqlite') {
    return new Sequelize({
      dialect: 'sqlite',
      storage: env.DB_HOST || env.DB_STORAGE || path.join(process.cwd(), 'data.db'),
      logging: false
    });
  }
  return new Sequelize(env.DB_DATABASE, env.DB_USERNAME, env.DB_PASSWORD, {
    host: env.DB_HOST || '127.0.0.1',
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    dialect,
    logging: false
  });
};

module.exports = {
  SQL_MIGRATIONS_TABLE,
  MIGRATION_ACTIONS,
  isValidSqlFileName,
  ensureMigrationsTable,
  readExecutedMigrations,
  recordMigration,
  removeMigrationRecord,
  runSqlMigrations,
  createSequelizeFromEnv
};
