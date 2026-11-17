-- 宿主库升级脚本（可选）：当 ensureSchema 未跑到、或需离线补齐时执行。
-- 默认表前缀 t_app_manager_；若宿主传了 dbTableNamePrefix / DB_TABLE_PREFIX，请改表名。
-- 幂等。对应 @kne/fastify-app-manager >= 0.1.30 libs/models/app.js

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 't_app_manager_app'
  ) THEN
    ALTER TABLE t_app_manager_app
      ADD COLUMN IF NOT EXISTS kind VARCHAR(255) NOT NULL DEFAULT 'managed';
    COMMENT ON COLUMN t_app_manager_app.kind IS 'managed=本机托管 | linked=外部关联';

    ALTER TABLE t_app_manager_app ALTER COLUMN port DROP NOT NULL;
    ALTER TABLE t_app_manager_app ALTER COLUMN root_path DROP NOT NULL;
    ALTER TABLE t_app_manager_app ALTER COLUMN pm2_name DROP NOT NULL;

    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 't_app_manager_app'
        AND indexname = 't_app_manager_app_kind'
    ) THEN
      CREATE INDEX t_app_manager_app_kind ON t_app_manager_app (kind);
    END IF;
  END IF;
END $$;
