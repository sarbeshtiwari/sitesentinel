-- =============================================================================
-- 040 — Tamper-evident, append-only audit log (D-16).
--  * BEFORE INSERT trigger assigns per-stream seq, prev_hash and hash under an
--    advisory lock, so the chain is correct under concurrent writers and cannot
--    be forged by application code.
--  * UPDATE/DELETE are rejected for everyone, except archival deletion by the
--    schema owner with `SET LOCAL app.audit_archive = 'on'` (after the rows'
--    anchor has been exported).
--  * public.audit_verify(stream) recomputes the chain and reports the first break.
-- Idempotent.
-- =============================================================================

-- Canonical text of an audit row. Timestamps are epoch microseconds so the
-- result does not depend on the session TimeZone; jsonb key order is deterministic.
CREATE OR REPLACE FUNCTION public.audit_canonical(r public.audit_logs) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'stream', r.stream,
    'seq', r.seq,
    'occurred_at_us', (extract(epoch FROM r.occurred_at) * 1000000)::bigint,
    'org_id', r.org_id,
    'actor_type', r.actor_type,
    'actor_id', r.actor_id,
    'actor_label', r.actor_label,
    'action', r.action,
    'target_type', r.target_type,
    'target_id', r.target_id,
    'ip_prefix', r.ip_prefix,
    'request_id', r.request_id,
    'changes', r.changes,
    'reason', r.reason
  )::text
$$;

-- SECURITY DEFINER: the chain must see the stream's previous row even when the
-- inserting role's RLS (060_identity.sql) would hide it.
CREATE OR REPLACE FUNCTION public.audit_logs_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_last record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.stream, 0));
  SELECT seq, hash INTO v_last
    FROM public.audit_logs
   WHERE stream = NEW.stream
   ORDER BY seq DESC
   LIMIT 1;
  NEW.seq        := coalesce(v_last.seq, 0) + 1;
  NEW.prev_hash  := coalesce(v_last.hash, repeat('0', 64));
  -- Truncate to microseconds so the stored value round-trips exactly.
  NEW.occurred_at := date_trunc('microseconds', coalesce(NEW.occurred_at, now()));
  NEW.hash       := encode(sha256(convert_to(NEW.prev_hash || '|' || public.audit_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_logs_chain ON public.audit_logs;
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_chain();

CREATE OR REPLACE FUNCTION public.audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'wim_owner'
     AND coalesce(current_setting('app.audit_archive', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS audit_logs_immutable ON public.audit_logs;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();

-- Also block TRUNCATE (row triggers do not fire for it).
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_immutable();

-- Verify a stream's chain. Returns zero rows if intact, else the first broken seq.
-- Verification starts at the oldest retained row (archived rows are covered by anchors).
CREATE OR REPLACE FUNCTION public.audit_verify(p_stream text)
RETURNS TABLE (broken_seq bigint, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r public.audit_logs;
  v_prev text := NULL;
  v_expected text;
BEGIN
  FOR r IN SELECT * FROM public.audit_logs WHERE stream = p_stream ORDER BY seq LOOP
    IF v_prev IS NOT NULL AND r.prev_hash <> v_prev THEN
      broken_seq := r.seq; reason := 'prev_hash does not match previous row'; RETURN NEXT; RETURN;
    END IF;
    v_expected := encode(sha256(convert_to(r.prev_hash || '|' || public.audit_canonical(r), 'UTF8')), 'hex');
    IF r.hash <> v_expected THEN
      broken_seq := r.seq; reason := 'row content does not match hash'; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
END $$;
