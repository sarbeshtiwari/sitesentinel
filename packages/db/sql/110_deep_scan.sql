-- =============================================================================
-- 110 — Phase 4E: deep scanning. Narrow scanner role, scan integrity rules, customer functions, admin aggregates.
-- Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------- wim_scanner: the deep-scan worker's role
-- Created here without a password; environments set one (infra/postgres/init/002_scanner_role.sql for dev/CI).
-- Compared with wim_worker it has NO access to users, sessions, credentials, payments, invoices, audit, SDK events,
-- artifacts, notifications, API endpoints, email, or admin tables — only what scheduling eligibility, execution
-- lifecycle, scanning, findings, incidents/outbox and usage need.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_scanner') THEN
    CREATE ROLE wim_scanner NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wim_scanner;
GRANT USAGE ON SCHEMA public TO wim_scanner;
GRANT SELECT ON public.platform_settings, public.websites, public.domain_claims, public.domain_registry, public.organizations,
  public.trials, public.subscriptions, public.plan_entitlements, public.entitlement_overrides, public.monitoring_configurations,
  public.incident_rules, public.monitoring_schedules TO wim_scanner;
GRANT SELECT, UPDATE ON public.monitoring_executions TO wim_scanner;
GRANT SELECT, INSERT ON public.execution_results, public.job_failures, public.system_health_logs, public.outbox_events,
  public.incident_events, public.incident_occurrences TO wim_scanner;
GRANT SELECT, INSERT, UPDATE ON public.usage_counters, public.incidents, public.discovered_pages TO wim_scanner;
-- Usage counters drive quotas (and later billing): only workers write them. The customer API only reads them
-- (Phase 4E narrows the schema-wide Phase 1 grant).
REVOKE INSERT, UPDATE, DELETE ON public.usage_counters FROM wim_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_heartbeats, public.deep_scans, public.deep_scan_urls,
  public.scan_findings, public.scan_finding_events TO wim_scanner;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wim_scanner;

-- System-context access for the scanner on the RLS-protected tables it uses (the worker binds every operation to the
-- execution's organisation from trusted rows; the database limits WHICH tables, the runtime limits WHICH rows).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['websites', 'organizations', 'domain_claims', 'trials', 'subscriptions', 'entitlement_overrides',
      'monitoring_configurations', 'incident_rules', 'monitoring_schedules', 'monitoring_executions', 'execution_results',
      'usage_counters', 'incidents', 'incident_events', 'incident_occurrences', 'discovered_pages', 'system_health_logs',
      'deep_scans', 'deep_scan_urls', 'scan_findings', 'scan_finding_events'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity) THEN
      EXECUTE format('DROP POLICY IF EXISTS scanner_system ON public.%I', t);
      EXECUTE format('CREATE POLICY scanner_system ON public.%I TO wim_scanner USING (public.app_is_system()) WITH CHECK (public.app_is_system())', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- integrity
-- A scan belongs to exactly one T3 execution of the same organisation and website.
CREATE OR REPLACE FUNCTION public.deep_scan_matches_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM monitoring_executions e JOIN websites w ON w.id = e.website_id
                  WHERE e.id = NEW.execution_id AND e.org_id = NEW.org_id AND e.website_id = NEW.website_id
                    AND e.tier = 'T3_DEEP' AND w.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'deep scan % does not match a deep-scan execution of this organisation and website', NEW.execution_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deep_scan_matches_execution ON public.deep_scans;
CREATE TRIGGER deep_scan_matches_execution BEFORE INSERT OR UPDATE OF execution_id, org_id, website_id ON public.deep_scans
  FOR EACH ROW EXECUTE FUNCTION public.deep_scan_matches_execution();

-- A final scan status needs the execution's single logical result (execution_results, tier T3_DEEP).
CREATE OR REPLACE FUNCTION public.deep_scan_final_needs_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('COMPLETED', 'PARTIAL', 'INCONCLUSIVE') AND NOT EXISTS (
      SELECT 1 FROM execution_results r WHERE r.execution_id = NEW.execution_id AND r.tier = 'T3_DEEP' AND r.website_id = NEW.website_id) THEN
    RAISE EXCEPTION 'deep scan % can only be finalised together with its execution result', NEW.execution_id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('COMPLETED', 'PARTIAL', 'INCONCLUSIVE', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'deep scan % is already final', NEW.execution_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deep_scan_final_needs_ledger ON public.deep_scans;
CREATE TRIGGER deep_scan_final_needs_ledger BEFORE UPDATE OF status ON public.deep_scans
  FOR EACH ROW EXECUTE FUNCTION public.deep_scan_final_needs_ledger();

-- At most one running scan per website (a manual and a scheduled scan can't crawl the same site at once).
CREATE UNIQUE INDEX IF NOT EXISTS deep_scans_one_running_per_website ON public.deep_scans (website_id) WHERE status = 'RUNNING';

-- Frontier rows and findings stay inside their scan's / website's organisation.
CREATE OR REPLACE FUNCTION public.deep_scan_child_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'deep_scan_urls' THEN
    IF NOT EXISTS (SELECT 1 FROM deep_scans s WHERE s.execution_id = NEW.execution_id AND s.org_id = NEW.org_id AND s.website_id = NEW.website_id) THEN
      RAISE EXCEPTION 'frontier row does not match its scan' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM websites w WHERE w.id = NEW.website_id AND w.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'finding does not match its website''s organisation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deep_scan_child_tenant ON public.deep_scan_urls;
CREATE TRIGGER deep_scan_child_tenant BEFORE INSERT OR UPDATE OF execution_id, org_id, website_id ON public.deep_scan_urls
  FOR EACH ROW EXECUTE FUNCTION public.deep_scan_child_tenant();
DROP TRIGGER IF EXISTS deep_scan_child_tenant ON public.scan_findings;
CREATE TRIGGER deep_scan_child_tenant BEFORE INSERT OR UPDATE OF org_id, website_id ON public.scan_findings
  FOR EACH ROW EXECUTE FUNCTION public.deep_scan_child_tenant();

-- ---------------------------------------------------------------- customer role: read own rows only
REVOKE INSERT, UPDATE, DELETE ON public.deep_scans, public.deep_scan_urls, public.scan_findings, public.scan_finding_events FROM wim_app;

/** Start a deep scan now (customer). Checks membership + monitoring:write, eligibility and cooldown in the database. */
CREATE OR REPLACE FUNCTION public.request_deep_scan(p_website uuid, p_cooldown_sec int)
RETURNS TABLE (result text, execution_id uuid, queued_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record; s record; v_id uuid := gen_random_uuid(); v_at timestamptz := date_trunc('milliseconds', now()); v_until timestamptz;
BEGIN
  SELECT * INTO w FROM websites WHERE id = p_website AND archived_at IS NULL;
  IF NOT FOUND OR w.org_id IS DISTINCT FROM app_current_org() THEN RETURN QUERY SELECT 'NOT_FOUND', NULL::uuid, NULL::timestamptz; RETURN; END IF;
  PERFORM app_enter_org(w.org_id, app_current_user(), 'monitoring:write');
  -- the schedule row reflects eligibility (platform switch, entitlement, ownership, website status, pause, cap)
  SELECT * INTO s FROM monitoring_schedules WHERE website_id = p_website AND tier = 'T3_DEEP' AND api_endpoint_id IS NULL FOR UPDATE;
  IF NOT FOUND OR s.status <> 'ACTIVE' THEN RETURN QUERY SELECT 'NOT_ELIGIBLE:' || coalesce(s.paused_reason, 'NO_SCHEDULE'), NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM monitoring_executions e WHERE e.website_id = p_website AND e.tier = 'T3_DEEP'
               AND e.status IN ('SCHEDULED', 'QUEUED', 'RUNNING', 'RETRYING') AND e.queued_at > now() - interval '8 days') THEN
    RETURN QUERY SELECT 'ALREADY_RUNNING', NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  -- cooldown: a manual scan that actually ran (or is running). One cancelled before it started never crawled anything,
  -- so it doesn't block the next one. queued_at of the row carries when the cooldown ends.
  SELECT max(e.queued_at) + make_interval(secs => p_cooldown_sec) INTO v_until FROM monitoring_executions e
   WHERE e.website_id = p_website AND e.tier = 'T3_DEEP' AND e.trigger = 'MANUAL'
     AND e.queued_at > now() - make_interval(secs => p_cooldown_sec)
     AND NOT (e.status = 'CANCELLED' AND e.started_at IS NULL);
  IF v_until IS NOT NULL THEN
    RETURN QUERY SELECT 'COOLDOWN', NULL::uuid, v_until; RETURN;
  END IF;
  INSERT INTO monitoring_executions (id, queued_at, org_id, website_id, schedule_id, tier, trigger, status, enqueued_at)
  VALUES (v_id, v_at, w.org_id, p_website, s.id, 'T3_DEEP', 'MANUAL', 'SCHEDULED', now());
  RETURN QUERY SELECT 'SCHEDULED', v_id, v_at;
END $$;
REVOKE ALL ON FUNCTION public.request_deep_scan(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_deep_scan(uuid, int) TO wim_app;

-- ---------------------------------------------------------------- Super Admin aggregate (no org, website, URL, finding text)
CREATE OR REPLACE VIEW public.admin_v_deepscan_health AS
SELECT count(*) FILTER (WHERE status = 'RUNNING')                                                   AS running,
       count(*) FILTER (WHERE finished_at > now() - interval '24 hours' AND status = 'COMPLETED')   AS completed_24h,
       count(*) FILTER (WHERE finished_at > now() - interval '24 hours' AND status = 'PARTIAL')     AS partial_24h,
       count(*) FILTER (WHERE finished_at > now() - interval '24 hours' AND status = 'CANCELLED')   AS cancelled_24h,
       count(*) FILTER (WHERE finished_at > now() - interval '24 hours' AND status = 'INCONCLUSIVE') AS inconclusive_24h,
       coalesce(sum(pages_completed) FILTER (WHERE finished_at > now() - interval '24 hours'), 0)   AS pages_24h,
       coalesce(sum(requests) FILTER (WHERE finished_at > now() - interval '24 hours'), 0)          AS requests_24h,
       coalesce(sum(bytes) FILTER (WHERE finished_at > now() - interval '24 hours'), 0)             AS bytes_24h,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at))
         FILTER (WHERE finished_at > now() - interval '24 hours')                                   AS p95_duration_sec_24h,
       (SELECT count(*) FROM scan_findings f WHERE f.status = 'OPEN')                               AS open_findings
  FROM deep_scans WHERE started_at > now() - interval '7 days';

GRANT SELECT ON public.admin_v_deepscan_health TO wim_admin, wim_readonly;
