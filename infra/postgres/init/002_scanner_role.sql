-- Phase 4E: the deep-scan worker's narrow role (dev/CI password; production sets its own).
-- The role's grants and policies live in packages/db/sql/110_deep_scan.sql; this only provides login.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_scanner') THEN
    CREATE ROLE wim_scanner LOGIN PASSWORD 'wim_scanner_dev_password' NOBYPASSRLS;
  ELSE
    ALTER ROLE wim_scanner LOGIN PASSWORD 'wim_scanner_dev_password';
  END IF;
END $$;
