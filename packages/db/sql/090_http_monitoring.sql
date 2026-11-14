-- =============================================================================
-- 090 — HTTP availability monitoring (Phase 4C). Idempotent.
-- =============================================================================

-- Partition maintenance is run by the scheduler (wim_worker). The two entry points take no input and
-- act only on partitions.config, so they run as the owner; create_one (parameterised) stays owner-only.
ALTER FUNCTION partitions.ensure_all() SECURITY DEFINER SET search_path = public, partitions, pg_temp;
ALTER FUNCTION partitions.apply_retention() SECURITY DEFINER SET search_path = public, partitions, pg_temp;
REVOKE ALL ON FUNCTION partitions.ensure_all(), partitions.apply_retention() FROM PUBLIC;
REVOKE ALL ON FUNCTION partitions.create_one(text, text, date) FROM PUBLIC, wim_worker;
GRANT EXECUTE ON FUNCTION partitions.ensure_all(), partitions.apply_retention() TO wim_worker;

-- Raw check results are kept as long as executions (≈60 days, the platform default for monitoring history).
UPDATE partitions.config SET retain = interval '62 days' WHERE parent = 'check_results' AND retain < interval '62 days';
SELECT partitions.ensure_all();

-- Results, occurrences and the outbox are written by workers only; customers read their own results (RLS).
REVOKE INSERT, UPDATE, DELETE ON public.check_results, public.incident_occurrences FROM wim_app;
REVOKE INSERT, UPDATE, DELETE ON public.outbox_events FROM wim_app;
-- Incidents: created and auto-resolved by workers; customer acknowledgement/resolution arrives with the incident UI (Phase 5).
REVOKE INSERT, DELETE ON public.incidents, public.incident_events FROM wim_app;

-- ---------------------------------------------------------------- Super Admin aggregate (no org, website, URL or address)
CREATE OR REPLACE VIEW public.admin_v_http_check_health AS
SELECT count(*) FILTER (WHERE checked_at > now() - interval '1 hour')                                      AS checks_1h,
       count(*) FILTER (WHERE checked_at > now() - interval '1 hour' AND status = 'PASSED')                AS passed_1h,
       count(*) FILTER (WHERE checked_at > now() - interval '1 hour' AND status = 'FAILED')                AS failed_1h,
       count(*) FILTER (WHERE checked_at > now() - interval '1 hour' AND status = 'INCONCLUSIVE')          AS inconclusive_1h,
       count(*) FILTER (WHERE checked_at > now() - interval '24 hours' AND failure_category = 'GATEWAY_INFRASTRUCTURE') AS infra_failures_24h,
       count(*) FILTER (WHERE checked_at > now() - interval '24 hours' AND failure_category = 'SECURITY_REJECTION')     AS security_rejections_24h,
       count(*) FILTER (WHERE checked_at > now() - interval '24 hours' AND failure_category = 'INVALID_CONFIGURATION')  AS blocked_destinations_24h,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE checked_at > now() - interval '1 hour')  AS p50_total_ms_1h,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) FILTER (WHERE checked_at > now() - interval '1 hour') AS p95_total_ms_1h,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (details #>> '{timings,gatewayMs}')::int)
         FILTER (WHERE checked_at > now() - interval '1 hour' AND details #>> '{timings,gatewayMs}' IS NOT NULL) AS p95_gateway_ms_1h,
       max(finished_at) FILTER (WHERE status <> 'INCONCLUSIVE')                                             AS last_completed_check_at
  FROM check_results
 WHERE checked_at > now() - interval '24 hours';

GRANT SELECT ON public.admin_v_http_check_health TO wim_admin, wim_readonly;
