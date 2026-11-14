-- Phase 4H: platform operations (health, self-alerts, usage reconciliation, retention configuration). Idempotent.
--
-- Principles: operational tables hold aggregate platform data only. Customers (wim_app) never see them. Super Admin
-- (wim_admin) reads them and changes them only through narrow column grants or SECURITY DEFINER functions that
-- validate input and keep the related record (adjustment, audit) in the same transaction.

CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO wim_worker, wim_admin;

-- ---- health snapshot and alerts: written by the evaluator (wim_worker), read by Super Admin
REVOKE ALL ON public.platform_health, public.platform_alerts, public.platform_alert_events,
              public.usage_reconciliation_runs, public.usage_discrepancies, public.usage_adjustments
  FROM wim_app, wim_readonly, wim_admin, wim_worker;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_browser') THEN
    EXECUTE 'REVOKE ALL ON public.platform_health, public.platform_alerts, public.platform_alert_events, public.usage_reconciliation_runs, public.usage_discrepancies, public.usage_adjustments FROM wim_browser';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_scanner') THEN
    EXECUTE 'REVOKE ALL ON public.platform_health, public.platform_alerts, public.platform_alert_events, public.usage_reconciliation_runs, public.usage_discrepancies, public.usage_adjustments FROM wim_scanner';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_health TO wim_worker;
GRANT SELECT, INSERT, UPDATE ON public.platform_alerts TO wim_worker;
GRANT SELECT, INSERT ON public.platform_alert_events TO wim_worker;
GRANT USAGE ON SEQUENCE public.platform_alert_events_id_seq TO wim_worker, wim_admin;
GRANT SELECT ON public.platform_health, public.platform_alerts, public.platform_alert_events TO wim_admin;
-- acknowledgement is the only change an operator makes to an alert
GRANT UPDATE (state, acknowledged_at, acknowledged_by_id) ON public.platform_alerts TO wim_admin;
GRANT INSERT ON public.platform_alert_events TO wim_admin;

-- ---- usage reconciliation: computed by the worker (it can read the ledger); operators request runs and resolve
GRANT SELECT, INSERT, UPDATE ON public.usage_reconciliation_runs TO wim_worker;
GRANT SELECT, INSERT, UPDATE ON public.usage_discrepancies TO wim_worker;
GRANT SELECT ON public.usage_adjustments TO wim_worker;
GRANT SELECT ON public.usage_reconciliation_runs, public.usage_discrepancies, public.usage_adjustments TO wim_admin;
GRANT INSERT (day, status, requested_by_id, requested_at) ON public.usage_reconciliation_runs TO wim_admin;

-- An alert must never be duplicated: at most one unrecovered alert per fingerprint.
CREATE UNIQUE INDEX IF NOT EXISTS platform_alerts_one_open ON public.platform_alerts (fingerprint) WHERE state <> 'RECOVERED';
-- (one discrepancy per run / org / check: declared in schema.prisma as usage_discrepancies_unique)

ALTER TABLE public.platform_alerts DROP CONSTRAINT IF EXISTS platform_alerts_state_chk;
ALTER TABLE public.platform_alerts ADD CONSTRAINT platform_alerts_state_chk CHECK (state IN ('OPEN', 'ACKNOWLEDGED', 'RECOVERED'));
ALTER TABLE public.platform_alerts DROP CONSTRAINT IF EXISTS platform_alerts_severity_chk;
ALTER TABLE public.platform_alerts ADD CONSTRAINT platform_alerts_severity_chk CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO'));
ALTER TABLE public.platform_health DROP CONSTRAINT IF EXISTS platform_health_state_chk;
ALTER TABLE public.platform_health ADD CONSTRAINT platform_health_state_chk CHECK (state IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'));
ALTER TABLE public.usage_reconciliation_runs DROP CONSTRAINT IF EXISTS usage_recon_status_chk;
ALTER TABLE public.usage_reconciliation_runs ADD CONSTRAINT usage_recon_status_chk CHECK (status IN ('REQUESTED', 'RUNNING', 'DONE', 'FAILED'));
ALTER TABLE public.usage_discrepancies DROP CONSTRAINT IF EXISTS usage_disc_status_chk;
ALTER TABLE public.usage_discrepancies ADD CONSTRAINT usage_disc_status_chk CHECK (status IN ('OPEN', 'ADJUSTED', 'ACCEPTED'));

-- Adjustments and alert events are history: never edited or deleted (also not by the worker).
CREATE OR REPLACE FUNCTION ops.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
DROP TRIGGER IF EXISTS append_only ON public.usage_adjustments;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.usage_adjustments FOR EACH ROW EXECUTE FUNCTION ops.append_only();
DROP TRIGGER IF EXISTS append_only ON public.platform_alert_events;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.platform_alert_events FOR EACH ROW EXECUTE FUNCTION ops.append_only();

-- ---- alert recipients: e-mail addresses of active operators, nothing else (the worker has no access to admin_users)
CREATE OR REPLACE FUNCTION ops.alert_recipients() RETURNS TABLE (email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.email::text FROM admin_users a WHERE a.active AND a.role IN ('SUPER_ADMIN', 'ADMIN_OPERATOR') ORDER BY a.email
$$;
REVOKE ALL ON FUNCTION ops.alert_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.alert_recipients() TO wim_worker;

-- ---- usage adjustment: counter change + adjustment record (+ discrepancy resolution) atomically.
-- The caller (admin API) writes the audit-log entry in the same transaction.
CREATE OR REPLACE FUNCTION ops.apply_usage_adjustment(p_org uuid, p_day date, p_key text, p_delta bigint, p_reason text, p_actor uuid, p_discrepancy uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_now bigint;
BEGIN
  IF p_delta = 0 OR abs(p_delta) > 100000000 THEN RAISE EXCEPTION 'invalid adjustment' USING ERRCODE = 'check_violation'; END IF;
  IF p_key !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,3}$' THEN RAISE EXCEPTION 'invalid usage key' USING ERRCODE = 'check_violation'; END IF;
  IF length(coalesce(btrim(p_reason), '')) < 10 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_day > (now() AT TIME ZONE 'UTC')::date OR p_day < (now() AT TIME ZONE 'UTC')::date - 400 THEN
    RAISE EXCEPTION 'day out of range' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = p_org) THEN RAISE EXCEPTION 'unknown organisation' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE id = p_actor AND active) THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT value INTO v_now FROM usage_counters WHERE org_id = p_org AND period_start = p_day AND key = p_key FOR UPDATE;
  IF coalesce(v_now, 0) + p_delta < 0 THEN RAISE EXCEPTION 'adjustment would make usage negative' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO usage_counters (org_id, period_start, key, value, updated_at) VALUES (p_org, p_day, p_key, p_delta, now())
    ON CONFLICT (org_id, period_start, key) DO UPDATE SET value = usage_counters.value + EXCLUDED.value, updated_at = now();
  INSERT INTO usage_adjustments (org_id, day, key, delta, reason, actor_id, discrepancy_id)
    VALUES (p_org, p_day, p_key, p_delta, btrim(p_reason), p_actor, p_discrepancy) RETURNING id INTO v_id;
  IF p_discrepancy IS NOT NULL THEN
    UPDATE usage_discrepancies SET status = 'ADJUSTED', resolved_by_id = p_actor, resolved_at = now(), resolution = btrim(p_reason)
     WHERE id = p_discrepancy AND org_id = p_org AND status = 'OPEN';
    IF NOT FOUND THEN RAISE EXCEPTION 'discrepancy not open for this organisation' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION ops.apply_usage_adjustment(uuid, date, text, bigint, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.apply_usage_adjustment(uuid, date, text, bigint, text, uuid, uuid) TO wim_admin;

-- Accept a discrepancy as explained (no counter change); the reason is mandatory.
CREATE OR REPLACE FUNCTION ops.accept_usage_discrepancy(p_id uuid, p_reason text, p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF length(coalesce(btrim(p_reason), '')) < 10 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE id = p_actor AND active) THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE usage_discrepancies SET status = 'ACCEPTED', resolved_by_id = p_actor, resolved_at = now(), resolution = btrim(p_reason)
   WHERE id = p_id AND status = 'OPEN';
  IF NOT FOUND THEN RAISE EXCEPTION 'discrepancy not open' USING ERRCODE = 'check_violation'; END IF;
END $$;
REVOKE ALL ON FUNCTION ops.accept_usage_discrepancy(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.accept_usage_discrepancy(uuid, text, uuid) TO wim_admin;

-- ---- retention: operators may change how long partitioned history is kept, never below the floor for the table
CREATE OR REPLACE FUNCTION ops.retention_floor_days(p_parent text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_parent
    WHEN 'security_events' THEN 365          -- security investigations
    WHEN 'login_attempts' THEN 90
    WHEN 'notification_delivery_logs' THEN 30
    WHEN 'system_health_logs' THEN 30         -- operational history for incident reviews
    WHEN 'incident_occurrences' THEN 30
    WHEN 'monitoring_executions' THEN 14      -- reconciliation window
    WHEN 'metrics_daily' THEN 90
    ELSE 7 END
$$;
CREATE OR REPLACE FUNCTION ops.retention_view() RETURNS TABLE (parent text, granularity text, retain_days int, floor_days int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.parent, c.granularity, extract(day FROM c.retain)::int, ops.retention_floor_days(c.parent) FROM partitions.config c ORDER BY c.parent
$$;
CREATE OR REPLACE FUNCTION ops.set_retention(p_parent text, p_days int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_before int;
BEGIN
  SELECT extract(day FROM retain)::int INTO v_before FROM partitions.config WHERE parent = p_parent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown table' USING ERRCODE = 'check_violation'; END IF;
  IF p_days < ops.retention_floor_days(p_parent) OR p_days > 1095 THEN
    RAISE EXCEPTION 'retention for % must be between % and 1095 days', p_parent, ops.retention_floor_days(p_parent) USING ERRCODE = 'check_violation';
  END IF;
  UPDATE partitions.config SET retain = make_interval(days => p_days) WHERE parent = p_parent;
  RETURN v_before;
END $$;
REVOKE ALL ON FUNCTION ops.retention_view(), ops.set_retention(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.retention_view(), ops.set_retention(text, int) TO wim_admin;

-- ---- Super Admin usage views: counts per organisation and day, never content. Organisation names come from the
-- existing admin_v_organizations (metadata the customers page already shows).
CREATE OR REPLACE VIEW public.admin_v_usage_daily AS
SELECT u.org_id, u.period_start AS day, u.key, u.value
  FROM usage_counters u
 WHERE u.period_start > (now() AT TIME ZONE 'UTC')::date - 400;
REVOKE ALL ON public.admin_v_usage_daily FROM PUBLIC;
GRANT SELECT ON public.admin_v_usage_daily TO wim_admin;

-- ---- 4H hardening: the Super Admin role never needs a customer's site origin (domains are shown from the domain
-- registry for the ledger/transfer workflows). Narrow the Phase 2 column grant.
REVOKE SELECT (canonical_origin) ON public.websites FROM wim_admin;

-- ---- 4H hardening: configuration history is evidence — the admin role appends, never edits or deletes it
REVOKE UPDATE, DELETE ON public.platform_setting_history FROM wim_admin;
DROP TRIGGER IF EXISTS append_only ON public.platform_setting_history;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.platform_setting_history FOR EACH ROW EXECUTE FUNCTION ops.append_only();
