-- Release readiness, blocker 3: least-privilege database role for worker-browser. Idempotent.
--
-- Until now worker-browser connected as wim_worker (every table, every tenant). It now connects as wim_browser with
-- exactly what its code path uses (inventory: docs/RELEASE_READINESS.md §3). Principles:
--  * only the columns it reads or writes; no DELETE except its own artifact cleanup and its own heartbeat row;
--  * monitoring_executions: browser-tier rows only (RLS), column-limited UPDATE, execution ownership columns
--    (org_id, website_id, tier, queued_at) are never updatable;
--  * result tables: INSERT only (no UPDATE/DELETE of recorded results), and only T2 rows (ledger trigger + RLS);
--  * no access at all to users, credentials, sessions, API endpoints, notification settings, audit logs, billing,
--    admin or secret tables, deep-scan data, HTTP check results.
-- RLS: a dedicated `browser_access` policy (app.system = on) on the tables it touches; on monitoring_executions and
-- execution_results it is restricted to the browser tier.

-- ---------------------------------------------------------------- reset to nothing
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wim_browser;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM wim_browser;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM wim_browser;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ops') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM wim_browser';
    EXECUTE 'REVOKE ALL ON SCHEMA ops FROM wim_browser';
  END IF;
END $$;
ALTER ROLE wim_browser NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
ALTER ROLE wim_browser SET statement_timeout = '60s';
ALTER ROLE wim_browser SET idle_in_transaction_session_timeout = '60s';
GRANT EXECUTE ON FUNCTION public.app_current_org(), public.app_is_system() TO wim_browser;

-- ---------------------------------------------------------------- configuration and eligibility (read)
GRANT SELECT (key, scope, value, version, updated_by_id, updated_at) ON public.platform_settings TO wim_browser;
GRANT SELECT (id, status) ON public.organizations TO wim_browser;
GRANT SELECT (id, org_id, status, archived_at, created_at, domain_claim_id, canonical_origin) ON public.websites TO wim_browser;
GRANT SELECT (id, status, domain_registry_id) ON public.domain_claims TO wim_browser;
GRANT SELECT (id, registrable_domain) ON public.domain_registry TO wim_browser;
GRANT SELECT (website_id, browser_check, deep_scan, t1_interval_sec, t2_interval_sec, t3_interval_sec) ON public.monitoring_configurations TO wim_browser;
GRANT SELECT (id, org_id, status, ends_at) ON public.trials TO wim_browser;  -- Prisma always selects the primary key
GRANT SELECT (id, org_id, status, current_period_end, grace_ends_at, plan_id) ON public.subscriptions TO wim_browser;
GRANT SELECT ON public.plan_entitlements TO wim_browser;  -- plan configuration only (no tenant data)
GRANT SELECT (id, org_id, key, value, expires_at) ON public.entitlement_overrides TO wim_browser;
GRANT SELECT (category, failure_threshold, recovery_passes, website_id, org_id, enabled) ON public.incident_rules TO wim_browser;

-- ---------------------------------------------------------------- executions (browser tier only; ownership immutable)
GRANT SELECT (id, org_id, website_id, tier, status, queued_at, enqueued_at, started_at, lease_expires_at, worker_id, attempt, cancel_requested_at)
  ON public.monitoring_executions TO wim_browser;
GRANT UPDATE (status, worker_id, started_at, finished_at, lease_expires_at, attempt, duration_ms, summary, failure_category, error_message)
  ON public.monitoring_executions TO wim_browser;
GRANT SELECT (id, website_id, tier, api_endpoint_id, state, state_window_at) ON public.monitoring_schedules TO wim_browser;
GRANT UPDATE (state, state_window_at) ON public.monitoring_schedules TO wim_browser;

-- ---------------------------------------------------------------- ledger + results (insert only)
GRANT SELECT (execution_id, org_id, website_id, tier, window_start, outcome), INSERT (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
  ON public.execution_results TO wim_browser;
GRANT INSERT ON public.page_test_results, public.performance_metrics, public.responsive_test_results, public.component_test_results TO wim_browser;
-- artifacts: insert/refresh own screenshots, read + delete expired ones for cleanup (RLS keeps it to system access)
GRANT SELECT (id, org_id, website_id, execution_id, storage_key, bytes, sha256, expires_at, created_at), INSERT, UPDATE (bytes, sha256, expires_at), DELETE ON public.artifacts TO wim_browser;

-- ---------------------------------------------------------------- components (4F)
GRANT SELECT (id, org_id, website_id, url_hash), INSERT (org_id, website_id, url, url_hash, path_template, source, depth, last_seen_at), UPDATE (last_seen_at)
  ON public.discovered_pages TO wim_browser;
GRANT SELECT (id, org_id, website_id, discovered_page_id), INSERT (org_id, website_id, discovered_page_id, t2_enabled, last_result_at), UPDATE (last_result_at, t2_enabled)
  ON public.monitored_pages TO wim_browser;
GRANT SELECT, INSERT, UPDATE ON public.page_components TO wim_browser;
GRANT SELECT (id, org_id, website_id, page_component_id, execution_id, type), INSERT ON public.component_events TO wim_browser;
GRANT USAGE ON SEQUENCE public.component_events_id_seq TO wim_browser;

-- ---------------------------------------------------------------- incidents (open / occurrence / resolve, own fingerprint)
GRANT SELECT, INSERT, UPDATE (status, resolved_at, resolved_by_id, auto_resolved, reopen_count, occurrence_count, last_detected_at, severity, diagnostics, updated_at)
  ON public.incidents TO wim_browser;
GRANT INSERT ON public.incident_events, public.incident_occurrences TO wim_browser;
-- ON CONFLICT (dedupe_key) DO NOTHING needs SELECT on the arbiter column only (no payloads, no other tenants' events)
GRANT SELECT (dedupe_key), INSERT (org_id, topic, payload, dedupe_key) ON public.outbox_events TO wim_browser;
GRANT USAGE ON SEQUENCE public.outbox_events_id_seq TO wim_browser;

-- ---------------------------------------------------------------- accounting + operations
GRANT SELECT (org_id, period_start, key, value), INSERT (org_id, period_start, key, value, updated_at), UPDATE (value, updated_at) ON public.usage_counters TO wim_browser;
-- operational metrics: Prisma create() sends recorded_at and returns the row (aggregate data only; no customer content)
GRANT SELECT, INSERT (recorded_at, component, metric, value, labels) ON public.system_health_logs TO wim_browser;
GRANT SELECT (id, queue, job_id, failed_at), INSERT (queue, job_id, execution_id, org_id, website_id, job_type, failure_category, attempts, error, payload, failed_at) ON public.job_failures TO wim_browser;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_heartbeats TO wim_browser;
-- heartbeats are per process: the browser role may only touch browser-monitoring rows
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS browser_own_kind ON public.worker_heartbeats;
CREATE POLICY browser_own_kind ON public.worker_heartbeats TO wim_browser USING (kind = 'browser-monitoring') WITH CHECK (kind = 'browser-monitoring');
DROP POLICY IF EXISTS everyone_else ON public.worker_heartbeats;
CREATE POLICY everyone_else ON public.worker_heartbeats TO wim_worker, wim_scanner, wim_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- RLS: browser_access (system mode) on exactly these tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'websites', 'domain_claims', 'monitoring_configurations', 'trials', 'subscriptions',
                           'entitlement_overrides', 'incident_rules', 'monitoring_schedules', 'artifacts', 'page_test_results',
                           'performance_metrics', 'responsive_test_results', 'component_test_results', 'discovered_pages',
                           'monitored_pages', 'page_components', 'component_events', 'incidents', 'incident_events',
                           'incident_occurrences', 'usage_counters'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS browser_access ON public.%I', t);
    EXECUTE format('CREATE POLICY browser_access ON public.%I TO wim_browser USING (public.app_is_system()) WITH CHECK (public.app_is_system())', t);
  END LOOP;
  -- executions and the ledger: browser tier only (cannot read or write another tier's executions or verdicts)
  DROP POLICY IF EXISTS browser_access ON public.monitoring_executions;
  CREATE POLICY browser_access ON public.monitoring_executions TO wim_browser
    USING (public.app_is_system() AND tier = 'T2_RENDER') WITH CHECK (public.app_is_system() AND tier = 'T2_RENDER');
  DROP POLICY IF EXISTS browser_access ON public.execution_results;
  CREATE POLICY browser_access ON public.execution_results TO wim_browser
    USING (public.app_is_system() AND tier = 'T2_RENDER') WITH CHECK (public.app_is_system() AND tier = 'T2_RENDER');
END $$;
