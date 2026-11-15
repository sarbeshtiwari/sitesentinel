-- A deep scan whose execution ended without the worker finalising it (dead-lettered, timed out, worker killed and
-- not recovered) stayed RUNNING: the dashboard showed "Running" forever, Cancel answered "already finished", and the
-- website's next scan waited for it. Idempotent.

-- Close RUNNING scans whose execution is terminal. CANCELLED needs no execution result (deep_scan_final_needs_ledger).
CREATE OR REPLACE FUNCTION public.close_abandoned_deep_scans(p_website uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE deep_scans s SET status = 'CANCELLED', stop_reason = 'ABANDONED', finished_at = now(), updated_at = now()
    FROM monitoring_executions e
   WHERE s.status = 'RUNNING' AND e.id = s.execution_id
     AND (p_website IS NULL OR s.website_id = p_website)
     AND e.status::text NOT IN ('SCHEDULED', 'QUEUED', 'RUNNING', 'RETRYING');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.close_abandoned_deep_scans(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_abandoned_deep_scans(uuid) TO wim_worker;

-- Cancelling such a scan closes it instead of failing.
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
    UPDATE deep_scans SET status = 'CANCELLED', stop_reason = 'CANCELLED', finished_at = now(), updated_at = now()
     WHERE execution_id = p_execution AND status = 'RUNNING';
    RETURN 'CANCELLED';
  ELSIF e.status = 'RUNNING' THEN
    UPDATE monitoring_executions SET cancel_requested_at = now() WHERE id = p_execution AND queued_at = e.queued_at;
    RETURN 'CANCEL_REQUESTED';
  END IF;
  -- execution already terminal: a scan row it left RUNNING is closed (the website can scan again)
  UPDATE deep_scans SET status = 'CANCELLED', stop_reason = 'ABANDONED', finished_at = now(), updated_at = now()
   WHERE execution_id = p_execution AND status = 'RUNNING';
  IF FOUND THEN RETURN 'CANCELLED'; END IF;
  RETURN 'NOT_CANCELLABLE';
END $$;
REVOKE ALL ON FUNCTION public.request_execution_cancel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_execution_cancel(uuid) TO wim_app;
