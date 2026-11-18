-- 宿主库升级脚本（可选）：软删行不再占用 name/domain/pm2_name 唯一键。
-- 默认表前缀 t_app_manager_；若宿主传了 dbTableNamePrefix / DB_TABLE_PREFIX，请改表名。
-- 幂等。仅 PostgreSQL（部分唯一索引）。对应 @kne/fastify-app-manager libs/models/app.js
-- 也可由 bootstrap.ensureSchema 在启动时自动执行。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 't_app_manager_app'
  ) THEN
    ALTER TABLE t_app_manager_app DROP CONSTRAINT IF EXISTS t_app_manager_app_name_key;
    ALTER TABLE t_app_manager_app DROP CONSTRAINT IF EXISTS t_app_manager_app_domain_key;
    ALTER TABLE t_app_manager_app DROP CONSTRAINT IF EXISTS t_app_manager_app_pm2_name_key;
    DROP INDEX IF EXISTS t_app_manager_app_domain;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 't_app_manager_app_name_active_uk'
    ) THEN
      CREATE UNIQUE INDEX t_app_manager_app_name_active_uk
        ON t_app_manager_app (name) WHERE deleted_at IS NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 't_app_manager_app_domain_active_uk'
    ) THEN
      CREATE UNIQUE INDEX t_app_manager_app_domain_active_uk
        ON t_app_manager_app (domain) WHERE deleted_at IS NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 't_app_manager_app_pm2_name_active_uk'
    ) THEN
      CREATE UNIQUE INDEX t_app_manager_app_pm2_name_active_uk
        ON t_app_manager_app (pm2_name) WHERE deleted_at IS NULL;
    END IF;
  END IF;
END $$;
