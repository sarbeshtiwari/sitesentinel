-- Phase 4F: customer dashboard. Idempotent.

-- ---------------------------------------------------------------- incident acknowledgement
-- The only customer-driven incident transition. It never resolves: ACKNOWLEDGED stays an active status, so the
-- incident engine keeps recording occurrences and still auto-resolves on recovery. Conditional (OPEN / REOPENED
-- only) and idempotent: a retried request returns ALREADY and writes nothing. Membership and incident:write are
-- re-checked here, in the database.
CREATE OR REPLACE FUNCTION public.acknowledge_incident(p_incident uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i record;
BEGIN
  SELECT id, org_id, status::text AS status INTO i FROM incidents WHERE id = p_incident FOR UPDATE;
  IF NOT FOUND OR i.org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM app_enter_org(i.org_id, app_current_user(), 'incident:write');
  IF i.status = 'ACKNOWLEDGED' THEN RETURN 'ALREADY'; END IF;
  IF i.status NOT IN ('OPEN', 'REOPENED') THEN RETURN 'NOT_ACTIVE'; END IF;
  UPDATE incidents SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by_id = app_current_user(), updated_at = now() WHERE id = p_incident;
  INSERT INTO incident_events (org_id, incident_id, type, actor_type, actor_id, from_status, to_status, data)
  VALUES (i.org_id, p_incident, 'ACKNOWLEDGED', 'USER', app_current_user(), i.status::"IncidentStatus", 'ACKNOWLEDGED', '{}'::jsonb);
  RETURN 'ACKNOWLEDGED';
END $$;
REVOKE ALL ON FUNCTION public.acknowledge_incident(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_incident(uuid) TO wim_app;

-- The customer role no longer writes incidents or their events directly (Phase 1 grant): every customer
-- transition goes through the function above. Results, ledger and usage were already read-only.
REVOKE INSERT, UPDATE, DELETE ON public.incidents, public.incident_events FROM wim_app;

-- ---------------------------------------------------------------- retention, for the usage page (no other config)
CREATE OR REPLACE FUNCTION public.result_retention_days()
RETURNS TABLE (parent text, days int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, partitions, pg_temp AS $$
  SELECT parent, extract(day FROM retain)::int FROM partitions.config
   WHERE parent IN ('check_results', 'page_test_results', 'performance_metrics', 'incident_occurrences')
$$;
REVOKE ALL ON FUNCTION public.result_retention_days() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.result_retention_days() TO wim_app;

-- ---------------------------------------------------------------- notifications: customers read and mark read only
-- Notifications and delivery logs are written by worker-notify (wim_worker). The customer role may only set
-- read_at (the API also scopes every update to the signed-in user); it can't create, delete or rewrite them.
REVOKE INSERT, UPDATE, DELETE ON public.notifications FROM wim_app;
GRANT UPDATE (read_at) ON public.notifications TO wim_app;
REVOKE INSERT, UPDATE, DELETE ON public.notification_delivery_logs FROM wim_app;

-- ---------------------------------------------------------------- Super Admin aggregates (no org, website, URL, content)
CREATE OR REPLACE VIEW public.admin_v_monitoring_outcomes AS
SELECT tier::text AS tier,
       count(*) FILTER (WHERE recorded_at > now() - interval '24 hours')                                   AS results_24h,
       count(*) FILTER (WHERE recorded_at > now() - interval '24 hours' AND outcome = 'PASSED')            AS passed_24h,
       count(*) FILTER (WHERE recorded_at > now() - interval '24 hours' AND outcome = 'FAILED')            AS failed_24h,
       count(*) FILTER (WHERE recorded_at > now() - interval '24 hours' AND outcome = 'INCONCLUSIVE')      AS inconclusive_24h,
       count(*) FILTER (WHERE recorded_at > now() - interval '24 hours' AND attempt > 1)                   AS retried_24h,
       count(*)                                                                                            AS results_7d
  FROM execution_results WHERE recorded_at > now() - interval '7 days' GROUP BY tier;

CREATE OR REPLACE VIEW public.admin_v_usage_totals AS
SELECT key,
       sum(value) FILTER (WHERE period_start = (now() AT TIME ZONE 'UTC')::date) AS today,
       sum(value)                                                                AS last_30_days,
       count(DISTINCT org_id) FILTER (WHERE period_start = (now() AT TIME ZONE 'UTC')::date) AS organisations_today
  FROM usage_counters
 WHERE period_start > (now() AT TIME ZONE 'UTC')::date - 30 AND (key LIKE 'http.%' OR key LIKE 'browser.%' OR key LIKE 'deepscan.%')
 GROUP BY key;

GRANT SELECT ON public.admin_v_monitoring_outcomes, public.admin_v_usage_totals TO wim_admin, wim_readonly;
