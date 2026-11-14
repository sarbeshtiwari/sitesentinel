-- =============================================================================
-- 080 — Scheduler and queue infrastructure (Phase 4B).
--  * Only the scheduler/workers (wim_worker, system context) write schedules and
--    executions. The customer API can read its own (RLS) and request two things
--    through narrow SECURITY DEFINER functions: pause/resume monitoring of a
--    website, and cancel an execution.
--  * Super Admin reads queue/execution health through aggregate views only.
-- Idempotent.
-- =============================================================================

REVOKE INSERT, UPDATE, DELETE ON public.monitoring_schedules, public.monitoring_executions FROM wim_app;

/** Pause or resume monitoring of a website (ACTIVE <-> PAUSED only; never activates an unverified website). */
CREATE OR REPLACE FUNCTION public.set_website_monitoring_paused(p_website uuid, p_paused boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record;
BEGIN
  SELECT * INTO w FROM websites WHERE id = p_website AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR w.org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM app_enter_org(w.org_id, app_current_user(), 'website:write');
  IF p_paused THEN
    IF w.status <> 'ACTIVE' THEN RETURN 'NOT_ACTIVE'; END IF;
    UPDATE websites SET status = 'PAUSED', paused_at = now(), updated_at = now() WHERE id = p_website;
    -- Pending work is cancelled now; running work is asked to stop.
    UPDATE monitoring_executions SET status = 'CANCELLED', failure_category = 'CANCELLED', finished_at = now(),
           error_message = 'website paused'
     WHERE website_id = p_website AND status IN ('SCHEDULED', 'QUEUED', 'RETRYING');
    UPDATE monitoring_executions SET cancel_requested_at = now() WHERE website_id = p_website AND status = 'RUNNING';
    UPDATE monitoring_schedules SET status = 'PAUSED', paused_reason = 'WEBSITE_PAUSED', updated_at = now() WHERE website_id = p_website;
    RETURN 'PAUSED';
  ELSE
    IF w.status <> 'PAUSED' THEN RETURN 'NOT_PAUSED'; END IF;
    UPDATE websites SET status = 'ACTIVE', paused_at = NULL, updated_at = now() WHERE id = p_website;
    -- The scheduler's sync re-activates schedules on its next cycle (entitlement and tier checks apply).
    RETURN 'ACTIVE';
  END IF;
END $$;

/** Cancel one execution of the caller's org. Pending → CANCELLED now; running → cancel requested. */
CREATE OR REPLACE FUNCTION public.request_execution_cancel(p_execution uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record;
BEGIN
  SELECT * INTO e FROM monitoring_executions WHERE id = p_execution FOR UPDATE;
  IF NOT FOUND OR e.org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM app_enter_org(e.org_id, app_current_user(), 'website:write');
  IF e.status IN ('SCHEDULED', 'QUEUED', 'RETRYING') THEN
    UPDATE monitoring_executions SET status = 'CANCELLED', failure_category = 'CANCELLED', finished_at = now(), error_message = 'cancelled by user'
     WHERE id = p_execution AND queued_at = e.queued_at;
    RETURN 'CANCELLED';
  ELSIF e.status = 'RUNNING' THEN
    UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = p_execution AND queued_at = e.queued_at;
    RETURN 'CANCEL_REQUESTED';
  END IF;
  RETURN 'NOT_CANCELLABLE';
END $$;

REVOKE ALL ON FUNCTION public.set_website_monitoring_paused(uuid, boolean), public.request_execution_cancel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_website_monitoring_paused(uuid, boolean), public.request_execution_cancel(uuid) TO wim_app;

-- ---------------------------------------------------------------- Super Admin aggregates (no org, website or domain)
CREATE OR REPLACE VIEW public.admin_v_execution_health AS
SELECT tier::text AS tier,
       count(*) FILTER (WHERE status = 'SCHEDULED')                           AS scheduled,
       count(*) FILTER (WHERE status = 'QUEUED')                              AS queued,
       count(*) FILTER (WHERE status = 'RUNNING')                             AS running,
       count(*) FILTER (WHERE status = 'RETRYING')                            AS retrying,
       count(*) FILTER (WHERE status = 'SUCCEEDED' AND finished_at > now() - interval '1 hour')      AS succeeded_1h,
       count(*) FILTER (WHERE status = 'FAILED' AND finished_at > now() - interval '1 hour')         AS failed_1h,
       count(*) FILTER (WHERE status = 'DEAD_LETTERED' AND finished_at > now() - interval '24 hours') AS dead_lettered_24h,
       count(*) FILTER (WHERE status = 'CANCELLED' AND finished_at > now() - interval '24 hours')     AS cancelled_24h,
       count(*) FILTER (WHERE status = 'SKIPPED' AND finished_at > now() - interval '24 hours')       AS skipped_24h,
       coalesce(sum(attempt - 1) FILTER (WHERE finished_at > now() - interval '24 hours'), 0)         AS retries_24h,
       round(avg(duration_ms) FILTER (WHERE finished_at > now() - interval '1 hour'))                 AS avg_duration_ms_1h,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE finished_at > now() - interval '1 hour')  AS p50_duration_ms_1h,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE finished_at > now() - interval '1 hour') AS p95_duration_ms_1h,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (started_at - enqueued_at)) * 1000)
         FILTER (WHERE started_at > now() - interval '1 hour' AND enqueued_at IS NOT NULL)          AS p95_wait_ms_1h,
       count(*) FILTER (WHERE status = 'RUNNING' AND lease_expires_at < now())                       AS expired_leases
  FROM monitoring_executions
 WHERE queued_at > now() - interval '2 days'
 GROUP BY tier;

CREATE OR REPLACE VIEW public.admin_v_schedule_health AS
SELECT tier::text AS tier, status::text AS status, coalesce(paused_reason, '') AS paused_reason, count(*) AS schedules,
       count(*) FILTER (WHERE status = 'ACTIVE' AND next_run_at < now() - interval '2 minutes') AS overdue
  FROM monitoring_schedules
 GROUP BY 1, 2, 3;

GRANT SELECT ON public.admin_v_execution_health, public.admin_v_schedule_health TO wim_admin, wim_readonly;
-- Admins mark dead letters for replay; the scheduler (system context) performs the replay after re-checking eligibility.
REVOKE INSERT, UPDATE ON public.job_failures FROM wim_admin;
GRANT SELECT, UPDATE (replay_requested_at, replay_requested_by_id, replay_reason) ON public.job_failures TO wim_admin;
