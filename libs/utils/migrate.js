const path = require('node:path');
const fs = require('fs-extra');
const { Sequelize } = require('sequelize');
const { listSqlFiles } = require('./validatePackage');

const SQL_MIGRATIONS_TABLE = '_fs_sql_migrations';

/**
 * Run .sql files under server/{sqlPath} with the same tracking semantics as @kne/fastify-sequelize.
 */
const runSqlMigrations = async ({ serverDir, sqlPath = 'sql', env = {} }) => {
  const sqlDir = path.join(serverDir, sqlPath);
  const files = await listSqlFiles(sqlDir);
  if (!files.length) {
    return { executed: [], skipped: true };
  }

  const sequelize = createSequelizeFromEnv(env);
  try {
    await sequelize.authenticate();
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS ${SQL_MIGRATIONS_TABLE} (
        name VARCHAR(255) PRIMARY KEY,
        executed_at DATETIME
      )`
    );

    const [rows] = await sequelize.query(`SELECT name FROM ${SQL_MIGRATIONS_TABLE}`);
    const done = new Set((rows || []).map(r => r.name));
    const executed = [];

    for (const file of files) {
      if (done.has(file)) {
        continue;
      }
      const sql = await fs.readFile(path.join(sqlDir, file), 'utf8');
      await sequelize.query(sql);
      await sequelize.query(`INSERT INTO ${SQL_MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`, {
        replacements: [file, new Date().toISOString()]
      });
      executed.push(file);
    }
    return { executed, skipped: false };
  } finally {
    await sequelize.close();
  }
};

const createSequelizeFromEnv = env => {
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
  runSqlMigrations,
  createSequelizeFromEnv
};
