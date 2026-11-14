-- Release readiness (staging gate, blocker 6 review): wim_scanner parity with wim_browser. Idempotent.
--  * execution ownership (org_id, website_id, tier, queued_at, schedule_id, trigger) is never updatable by the scanner;
--    it may only move ITS executions through the runtime lifecycle (same columns as packages/queue/src/runtime.ts);
--  * in system mode it sees and writes only deep-scan executions and deep-scan verdicts.
REVOKE UPDATE ON public.monitoring_executions FROM wim_scanner;
GRANT UPDATE (status, worker_id, started_at, finished_at, lease_expires_at, attempt, duration_ms, summary, failure_category, error_message)
  ON public.monitoring_executions TO wim_scanner;
DROP POLICY IF EXISTS scanner_system ON public.monitoring_executions;
CREATE POLICY scanner_system ON public.monitoring_executions TO wim_scanner
  USING (public.app_is_system() AND tier = 'T3_DEEP') WITH CHECK (public.app_is_system() AND tier = 'T3_DEEP');
DROP POLICY IF EXISTS scanner_system ON public.execution_results;
CREATE POLICY scanner_system ON public.execution_results TO wim_scanner
  USING (public.app_is_system() AND tier = 'T3_DEEP') WITH CHECK (public.app_is_system() AND tier = 'T3_DEEP');
REVOKE UPDATE, DELETE ON public.execution_results FROM wim_scanner;
-- Only when needed: managed Postgres (Render, RDS, …) has no superuser, and any ALTER ROLE that names SUPERUSER is
-- refused there even when it only removes it. Same effect either way: the role ends with none of these attributes.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_scanner' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) THEN
    EXECUTE 'ALTER ROLE wim_scanner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION';
  END IF;
END $$;
