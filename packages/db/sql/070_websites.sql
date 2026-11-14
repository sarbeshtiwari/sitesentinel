-- =============================================================================
-- 070 — Websites, domain claims, verification, SDK ingest, transfers (Phase 3).
--
-- Principle: the customer API role (wim_app) can READ its own claims,
-- verifications and transfers but can never change verification state.
--   * claiming, releasing, token regeneration and transfer requests go through
--     SECURITY DEFINER functions that re-check membership + permission
--     (app_enter_org) and serialize per registrable domain (advisory lock);
--   * only wim_worker (verification worker, system context) marks claims VERIFIED;
--   * only wim_ingest (SDK endpoint) records heartbeats, through functions only —
--     it has no table privileges at all.
-- Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------- column-level write limits for wim_app
REVOKE INSERT, UPDATE, DELETE ON public.domain_claims, public.domain_registry, public.domain_verifications,
                                 public.domain_transfers, public.domain_trial_ledger, public.trials
  FROM wim_app;
GRANT INSERT ON public.domain_registration_attempts TO wim_app;
REVOKE UPDATE ON public.websites FROM wim_app;
GRANT UPDATE (name, description, category, monitoring_timezone, updated_at) ON public.websites TO wim_app;
REVOKE UPDATE ON public.site_installations FROM wim_app;
GRANT UPDATE (site_key, previous_site_key, previous_key_expires_at, revoked_at, key_created_at, telemetry_paused, sdk_config, updated_at)
  ON public.site_installations TO wim_app;
REVOKE DELETE ON public.websites, public.site_installations FROM wim_app; -- archive via archive_website()

-- New websites take their status from their claim, whoever inserts them.
CREATE OR REPLACE FUNCTION public.websites_status_from_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT status::text INTO v_status FROM domain_claims WHERE id = NEW.domain_claim_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'unknown domain claim' USING ERRCODE = 'foreign_key_violation'; END IF;
  NEW.status := CASE WHEN v_status = 'VERIFIED' THEN 'ACTIVE' ELSE 'PENDING_VERIFICATION' END::"WebsiteStatus";
  NEW.verified_at := CASE WHEN v_status = 'VERIFIED' THEN now() ELSE NULL END;
  NEW.trial_outcome := NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS websites_status_from_claim ON public.websites;
CREATE TRIGGER websites_status_from_claim BEFORE INSERT ON public.websites
  FOR EACH ROW EXECUTE FUNCTION public.websites_status_from_claim();

-- ---------------------------------------------------------------- RLS for tables without a plain org_id policy
-- domain_verifications got org_id in this phase and is covered by 020's tenant loop.

-- Registration attempts: anyone may log, a tenant reads only its own, workers/admin aggregate.
ALTER TABLE public.domain_registration_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attempts_insert ON public.domain_registration_attempts;
CREATE POLICY attempts_insert ON public.domain_registration_attempts FOR INSERT TO wim_app, wim_worker WITH CHECK (true);
DROP POLICY IF EXISTS attempts_read_own ON public.domain_registration_attempts;
CREATE POLICY attempts_read_own ON public.domain_registration_attempts FOR SELECT TO wim_app USING (org_id = public.app_current_org());
DROP POLICY IF EXISTS attempts_system ON public.domain_registration_attempts;
CREATE POLICY attempts_system ON public.domain_registration_attempts TO wim_worker USING (public.app_is_system()) WITH CHECK (public.app_is_system());
DROP POLICY IF EXISTS attempts_admin ON public.domain_registration_attempts;
CREATE POLICY attempts_admin ON public.domain_registration_attempts FOR SELECT TO wim_admin USING (true);

-- Transfers: the requester sees its own request; the current owner sees only a
-- minimal view through incoming_domain_transfers(); writes go through functions/worker/admin.
ALTER TABLE public.domain_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transfers_requester ON public.domain_transfers;
CREATE POLICY transfers_requester ON public.domain_transfers FOR SELECT TO wim_app USING (to_org_id = public.app_current_org());
DROP POLICY IF EXISTS transfers_system ON public.domain_transfers;
CREATE POLICY transfers_system ON public.domain_transfers TO wim_worker USING (public.app_is_system()) WITH CHECK (public.app_is_system());
DROP POLICY IF EXISTS transfers_admin ON public.domain_transfers;
CREATE POLICY transfers_admin ON public.domain_transfers TO wim_admin USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- claim lifecycle
CREATE OR REPLACE FUNCTION public.expire_stale_domain_claims(p_registrable text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE domain_claims c SET status = 'EXPIRED', released_at = now(), release_reason = 'EXPIRED', updated_at = now()
   WHERE c.status = 'PENDING' AND c.pending_expires_at < now()
     AND (p_registrable IS NULL OR c.domain_registry_id IN (SELECT id FROM domain_registry WHERE registrable_domain = p_registrable));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/**
 * Claim a website identity for the current org (ARCHITECTURE.md §11.3/11.4).
 * Outcomes: ACCEPTED | INHERITED_VERIFIED | DUPLICATE_OWN | DUPLICATE | DUPLICATE_NAMESPACE | BLOCKED | LIMIT.
 * The partial unique index domain_claims_one_live_claim remains the final guarantee.
 */
CREATE OR REPLACE FUNCTION public.register_domain_claim(
  p_org uuid, p_identity text, p_registrable text, p_display text, p_is_root boolean, p_policy text,
  p_token text, p_pending_hours int, p_max_pending int)
RETURNS TABLE (outcome text, claim_id uuid, registry_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_reg uuid; v_live record; v_root_id uuid; v_root_org uuid; v_has_root boolean; v_pending int; v_claim uuid; v_outcome text;
BEGIN
  PERFORM app_enter_org(p_org, app_current_user(), 'website:write');
  PERFORM pg_advisory_xact_lock(hashtextextended('domain:' || p_registrable, 0));

  IF EXISTS (SELECT 1 FROM blocked_domains WHERE pattern IN (p_registrable, p_identity))
     OR EXISTS (SELECT 1 FROM domain_registry WHERE identity_key IN (p_identity, p_registrable) AND blocked) THEN
    INSERT INTO domain_registration_attempts (org_id, input_host, outcome) VALUES (p_org, p_identity, 'BLOCKED');
    RETURN QUERY SELECT 'BLOCKED'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  PERFORM expire_stale_domain_claims(p_registrable);

  INSERT INTO domain_registry (identity_key, host_key, registrable_domain, display_host, is_root)
  VALUES (p_identity, p_identity, p_registrable, p_display, p_is_root)
  ON CONFLICT (identity_key) DO UPDATE SET display_host = EXCLUDED.display_host
  RETURNING id INTO v_reg;

  SELECT c.id, c.org_id INTO v_live FROM domain_claims c
   WHERE c.domain_registry_id = v_reg AND c.status IN ('PENDING', 'VERIFIED', 'LAPSED') FOR UPDATE;
  IF FOUND THEN
    v_outcome := CASE WHEN v_live.org_id = p_org THEN 'DUPLICATE_OWN' ELSE 'DUPLICATE' END;
    INSERT INTO domain_registration_attempts (domain_registry_id, org_id, input_host, outcome) VALUES (v_reg, p_org, p_identity, v_outcome);
    RETURN QUERY SELECT v_outcome, CASE WHEN v_outcome = 'DUPLICATE_OWN' THEN v_live.id END, v_reg; RETURN;
  END IF;

  -- ROOT_EXCLUSIVE: a DNS-verified ROOT claim on the registrable domain reserves every subdomain.
  SELECT c.id, c.org_id INTO v_root_id, v_root_org FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id
   WHERE r.identity_key = p_registrable AND c.scope = 'ROOT' AND c.status IN ('VERIFIED', 'LAPSED');
  v_has_root := FOUND;
  IF v_has_root AND p_policy = 'ROOT_EXCLUSIVE' AND v_root_org IS DISTINCT FROM p_org AND NOT p_is_root THEN
    INSERT INTO domain_registration_attempts (domain_registry_id, org_id, input_host, outcome, reason)
    VALUES (v_reg, p_org, p_identity, 'DUPLICATE_NAMESPACE', 'registrable domain reserved by another organization');
    RETURN QUERY SELECT 'DUPLICATE_NAMESPACE'::text, NULL::uuid, v_reg; RETURN;
  END IF;

  SELECT count(*) INTO v_pending FROM domain_claims WHERE org_id = p_org AND status = 'PENDING';
  IF v_pending >= p_max_pending THEN
    INSERT INTO domain_registration_attempts (domain_registry_id, org_id, input_host, outcome) VALUES (v_reg, p_org, p_identity, 'LIMIT');
    RETURN QUERY SELECT 'LIMIT'::text, NULL::uuid, v_reg; RETURN;
  END IF;

  IF v_has_root AND v_root_org = p_org AND NOT p_is_root THEN
    -- The org already proved control of the whole registrable domain via DNS.
    INSERT INTO domain_claims (domain_registry_id, org_id, scope, status, policy, verification_token, verified_at,
                               verified_method, inherited_from_claim_id, updated_at)
    VALUES (v_reg, p_org, 'HOST', 'VERIFIED', p_policy::"DomainPolicy", p_token, now(), 'DNS_TXT', v_root_id, now())
    RETURNING id INTO v_claim;
    v_outcome := 'INHERITED_VERIFIED';
  ELSE
    INSERT INTO domain_claims (domain_registry_id, org_id, scope, status, policy, verification_token, pending_expires_at, updated_at)
    VALUES (v_reg, p_org, 'HOST', 'PENDING', p_policy::"DomainPolicy", p_token, now() + make_interval(hours => p_pending_hours), now())
    RETURNING id INTO v_claim;
    v_outcome := 'ACCEPTED';
  END IF;

  INSERT INTO domain_trial_ledger (registrable_domain, registration_count, updated_at) VALUES (p_registrable, 1, now())
  ON CONFLICT (registrable_domain) DO UPDATE SET registration_count = domain_trial_ledger.registration_count + 1, updated_at = now();
  INSERT INTO domain_registration_attempts (domain_registry_id, org_id, input_host, outcome) VALUES (v_reg, p_org, p_identity, v_outcome);
  RETURN QUERY SELECT v_outcome, v_claim, v_reg;
END $$;

/** New proof value for a PENDING claim; the previous token stops working immediately. Does not extend expiry. */
CREATE OR REPLACE FUNCTION public.regenerate_claim_token(p_claim uuid, p_token text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM domain_claims WHERE id = p_claim AND status = 'PENDING' AND pending_expires_at > now();
  IF v_org IS NULL OR v_org <> app_current_org() THEN RETURN false; END IF;
  PERFORM app_enter_org(v_org, app_current_user(), 'website:write');
  UPDATE domain_claims SET verification_token = p_token, token_issued_at = now(), verification_attempts = 0, updated_at = now() WHERE id = p_claim;
  RETURN true;
END $$;

/** Count a verification attempt against the claim's token budget (called before enqueueing a check). */
CREATE OR REPLACE FUNCTION public.reserve_verification_attempt(p_claim uuid, p_max int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM domain_claims WHERE id = p_claim FOR UPDATE;
  IF NOT FOUND OR c.org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM app_enter_org(c.org_id, app_current_user(), 'website:write');
  IF c.status = 'PENDING' AND c.pending_expires_at <= now() THEN RETURN 'EXPIRED'; END IF;
  IF c.status NOT IN ('PENDING', 'VERIFIED', 'LAPSED') THEN RETURN 'NOT_PENDING'; END IF;
  IF c.verification_attempts >= p_max THEN RETURN 'TOKEN_EXHAUSTED'; END IF;
  UPDATE domain_claims SET verification_attempts = verification_attempts + 1, last_attempt_at = now(), updated_at = now() WHERE id = p_claim;
  RETURN 'OK';
END $$;

/**
 * Archive a website: release its claim (history kept), revoke its site key.
 * The domain trial ledger is untouched, so re-adding the domain later never yields a new trial.
 */
CREATE OR REPLACE FUNCTION public.archive_website(p_website uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record;
BEGIN
  SELECT * INTO w FROM websites WHERE id = p_website AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR w.org_id <> app_current_org() THEN RETURN false; END IF;
  PERFORM app_enter_org(w.org_id, app_current_user(), 'website:delete');
  UPDATE websites SET status = 'ARCHIVED', archived_at = now(), updated_at = now() WHERE id = p_website;
  UPDATE domain_claims SET status = 'RELEASED', released_at = now(), release_reason = 'WEBSITE_DELETED', updated_at = now()
   WHERE id = w.domain_claim_id AND status IN ('PENDING', 'VERIFIED', 'LAPSED');
  UPDATE domain_trial_ledger l SET last_released_at = now(), updated_at = now()
    FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id
   WHERE c.id = w.domain_claim_id AND l.registrable_domain = r.registrable_domain;
  UPDATE site_installations SET revoked_at = now(), previous_site_key = NULL, previous_key_expires_at = NULL, updated_at = now() WHERE website_id = p_website;
  RETURN true;
END $$;

/** Start a fresh claim for a website whose verification window expired (if the identity is still free). */
CREATE OR REPLACE FUNCTION public.restart_website_claim(p_website uuid, p_token text, p_pending_hours int, p_max_pending int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record; r record; res record;
BEGIN
  SELECT * INTO w FROM websites WHERE id = p_website AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR w.org_id <> app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  SELECT reg.* , c.status AS claim_status, c.pending_expires_at, c.policy INTO r
    FROM domain_claims c JOIN domain_registry reg ON reg.id = c.domain_registry_id WHERE c.id = w.domain_claim_id;
  IF NOT (r.claim_status = 'EXPIRED' OR (r.claim_status = 'PENDING' AND r.pending_expires_at <= now())) THEN RETURN 'NOT_EXPIRED'; END IF;
  SELECT * INTO res FROM register_domain_claim(w.org_id, r.identity_key, r.registrable_domain, r.display_host, r.is_root, r.policy::text, p_token, p_pending_hours, p_max_pending);
  IF res.outcome IN ('ACCEPTED', 'INHERITED_VERIFIED') THEN
    UPDATE websites SET domain_claim_id = res.claim_id,
           status = CASE WHEN res.outcome = 'INHERITED_VERIFIED' THEN 'ACTIVE' ELSE 'PENDING_VERIFICATION' END::"WebsiteStatus",
           updated_at = now()
     WHERE id = p_website;
  END IF;
  RETURN res.outcome;
END $$;

-- Org hard deletion (Phase 10 purge) releases claims first; the FK then nulls org_id.
CREATE OR REPLACE FUNCTION public.release_claims_on_org_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE domain_trial_ledger l SET last_released_at = now(), updated_at = now()
    FROM domain_claims c JOIN domain_registry r ON r.id = c.domain_registry_id
   WHERE c.org_id = OLD.id AND c.status IN ('PENDING', 'VERIFIED', 'LAPSED') AND l.registrable_domain = r.registrable_domain;
  UPDATE domain_claims SET status = 'RELEASED', released_at = now(), release_reason = 'ORG_DELETED', updated_at = now()
   WHERE org_id = OLD.id AND status IN ('PENDING', 'VERIFIED', 'LAPSED');
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS organizations_release_claims ON public.organizations;
CREATE TRIGGER organizations_release_claims BEFORE DELETE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.release_claims_on_org_delete();

-- ---------------------------------------------------------------- transfers
/** Is this identity free, ours, or claimed elsewhere? Never reveals who holds it. */
CREATE OR REPLACE FUNCTION public.domain_claim_status(p_identity text)
RETURNS TABLE (status text, registry_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE r record; c record;
BEGIN
  IF app_current_org() IS NULL THEN RAISE EXCEPTION 'tenant context required'; END IF;
  SELECT * INTO r FROM domain_registry WHERE identity_key = p_identity;
  IF NOT FOUND THEN RETURN QUERY SELECT 'UNCLAIMED'::text, NULL::uuid; RETURN; END IF;
  IF r.blocked THEN RETURN QUERY SELECT 'BLOCKED'::text, r.id; RETURN; END IF;
  SELECT * INTO c FROM domain_claims WHERE domain_registry_id = r.id AND status IN ('PENDING', 'VERIFIED', 'LAPSED')
     AND NOT (status = 'PENDING' AND pending_expires_at <= now());
  IF NOT FOUND THEN RETURN QUERY SELECT 'UNCLAIMED'::text, r.id; RETURN; END IF;
  RETURN QUERY SELECT CASE WHEN c.org_id = app_current_org() THEN 'YOURS'
                           WHEN c.status = 'PENDING' THEN 'PENDING_ELSEWHERE' ELSE 'CLAIMED_ELSEWHERE' END, r.id;
END $$;

/** Open a transfer request against another org's verified claim. Returns the transfer id or an error code. */
CREATE OR REPLACE FUNCTION public.request_domain_transfer(p_org uuid, p_identity text, p_token text, p_token_hours int)
RETURNS TABLE (outcome text, transfer_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; c record; v_id uuid;
BEGIN
  PERFORM app_enter_org(p_org, app_current_user(), 'website:write');
  SELECT * INTO r FROM domain_registry WHERE identity_key = p_identity;
  IF NOT FOUND THEN RETURN QUERY SELECT 'UNCLAIMED'::text, NULL::uuid; RETURN; END IF;
  SELECT * INTO c FROM domain_claims WHERE domain_registry_id = r.id AND status IN ('PENDING', 'VERIFIED', 'LAPSED') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'UNCLAIMED'::text, NULL::uuid; RETURN; END IF;
  IF c.org_id = p_org THEN RETURN QUERY SELECT 'YOURS'::text, NULL::uuid; RETURN; END IF;
  IF c.status = 'PENDING' THEN RETURN QUERY SELECT 'PENDING_ELSEWHERE'::text, NULL::uuid; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM domain_transfers WHERE domain_registry_id = r.id AND to_org_id = p_org
                AND status IN ('PENDING_VERIFICATION', 'PENDING_ADMIN')) THEN
    RETURN QUERY SELECT 'ALREADY_REQUESTED'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO domain_transfers (domain_registry_id, from_claim_id, from_org_id, to_org_id, requested_by_id, status,
                                verification_token, token_expires_at)
  VALUES (r.id, c.id, c.org_id, p_org, app_current_user(), 'PENDING_VERIFICATION', p_token, now() + make_interval(hours => p_token_hours))
  RETURNING id INTO v_id;
  INSERT INTO domain_registration_attempts (domain_registry_id, org_id, input_host, outcome) VALUES (r.id, p_org, p_identity, 'TRANSFER_REQUESTED');
  RETURN QUERY SELECT 'CREATED'::text, v_id;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_domain_transfer(p_transfer uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  SELECT * INTO t FROM domain_transfers WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND OR t.to_org_id IS DISTINCT FROM app_current_org() OR t.status NOT IN ('PENDING_VERIFICATION', 'PENDING_ADMIN') THEN RETURN false; END IF;
  PERFORM app_enter_org(t.to_org_id, app_current_user(), 'website:write');
  UPDATE domain_transfers SET status = 'CANCELLED', decided_at = now() WHERE id = p_transfer;
  RETURN true;
END $$;

/** Requester-side budget for DNS checks on a transfer. */
CREATE OR REPLACE FUNCTION public.reserve_transfer_attempt(p_transfer uuid, p_max int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  SELECT * INTO t FROM domain_transfers WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND OR t.to_org_id IS DISTINCT FROM app_current_org() THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM app_enter_org(t.to_org_id, app_current_user(), 'website:write');
  IF t.status <> 'PENDING_VERIFICATION' THEN RETURN 'NOT_PENDING'; END IF;
  IF t.token_expires_at <= now() THEN RETURN 'EXPIRED'; END IF;
  IF t.verification_attempts >= p_max THEN RETURN 'TOKEN_EXHAUSTED'; END IF;
  UPDATE domain_transfers SET verification_attempts = verification_attempts + 1 WHERE id = p_transfer;
  RETURN 'OK';
END $$;

/** The current owner's view of requests against its domains: no requester identity. */
CREATE OR REPLACE FUNCTION public.incoming_domain_transfers()
RETURNS TABLE (id uuid, website_id uuid, display_host text, status text, owner_response text, owner_respond_by timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, w.id, r.display_host, t.status::text, t.owner_response, t.owner_respond_by, t.created_at
    FROM domain_transfers t
    JOIN domain_registry r ON r.id = t.domain_registry_id
    LEFT JOIN websites w ON w.domain_claim_id = t.from_claim_id
   WHERE t.from_org_id = app_current_org() AND app_current_org() IS NOT NULL
   ORDER BY t.created_at DESC
$$;

CREATE OR REPLACE FUNCTION public.contest_domain_transfer(p_transfer uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  SELECT * INTO t FROM domain_transfers WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND OR t.from_org_id IS DISTINCT FROM app_current_org() OR t.status NOT IN ('PENDING_VERIFICATION', 'PENDING_ADMIN') THEN RETURN false; END IF;
  PERFORM app_enter_org(t.from_org_id, app_current_user(), 'website:write');
  UPDATE domain_transfers SET owner_response = 'CONTESTED' WHERE id = p_transfer;
  RETURN true;
END $$;

-- ---------------------------------------------------------------- SDK ingest (wim_ingest has no table grants)
CREATE OR REPLACE FUNCTION public.ingest_lookup(p_key text)
RETURNS TABLE (org_id uuid, website_id uuid, host_key text, website_status text, key_state text, telemetry_paused boolean, sdk_config jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.org_id, w.id, r.host_key, w.status::text,
         CASE WHEN si.site_key = p_key AND si.revoked_at IS NULL THEN 'CURRENT'
              WHEN si.site_key = p_key THEN 'REVOKED'
              WHEN si.previous_key_expires_at > now() THEN 'PREVIOUS'
              ELSE 'PREVIOUS_EXPIRED' END,
         si.telemetry_paused, si.sdk_config
    FROM site_installations si
    JOIN websites w ON w.id = si.website_id
    JOIN domain_claims c ON c.id = w.domain_claim_id
    JOIN domain_registry r ON r.id = c.domain_registry_id
   WHERE (si.site_key = p_key OR si.previous_site_key = p_key) AND w.archived_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.ingest_heartbeat(p_website uuid, p_valid boolean, p_new_page_load boolean,
                                                   p_sdk_version text, p_reason text, p_origin text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_valid THEN
    UPDATE site_installations
       SET first_seen_at = coalesce(first_seen_at, now()), last_seen_at = now(),
           heartbeat_count = heartbeat_count + CASE WHEN p_new_page_load THEN 1 ELSE 0 END,
           sdk_version = left(p_sdk_version, 20), updated_at = now()
     WHERE website_id = p_website;
  ELSE
    UPDATE site_installations
       SET last_invalid_at = now(), last_invalid_reason = left(p_reason, 40), last_invalid_origin = left(p_origin, 255), updated_at = now()
     WHERE website_id = p_website;
  END IF;
END $$;

/** Insert a batch of already-sanitised SDK events (max 50) for an active, unpaused website. */
CREATE OR REPLACE FUNCTION public.ingest_events(p_website uuid, p_events jsonb)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record; n int;
BEGIN
  SELECT ws.id, ws.org_id, ws.status, si.telemetry_paused INTO w
    FROM websites ws JOIN site_installations si ON si.website_id = ws.id WHERE ws.id = p_website;
  IF NOT FOUND OR w.status <> 'ACTIVE' OR w.telemetry_paused OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 50 THEN
    RETURN 0;
  END IF;
  INSERT INTO sdk_events (org_id, website_id, type, fingerprint, page_path, session_ref, device_type, browser, os, viewport_w, viewport_h, sdk_version, payload)
  SELECT w.org_id, w.id, left(e->>'type', 30), left(e->>'fingerprint', 64), left(coalesce(e->>'path', '/'), 500), left(e->>'sid', 40),
         left(e->>'device', 20), left(e->>'browser', 40), left(e->>'os', 40), (e->>'vw')::int, (e->>'vh')::int, left(e->>'sv', 20),
         coalesce(e->'data', '{}'::jsonb)
    FROM jsonb_array_elements(p_events) e
   WHERE e->>'type' IN ('JS_ERROR', 'REJECTION', 'RESOURCE', 'VITALS', 'NAV');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wim_ingest') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wim_ingest;
    GRANT EXECUTE ON FUNCTION public.ingest_lookup(text), public.ingest_heartbeat(uuid, boolean, boolean, text, text, text),
                              public.ingest_events(uuid, jsonb) TO wim_ingest;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.ingest_lookup(text), public.ingest_heartbeat(uuid, boolean, boolean, text, text, text),
                       public.ingest_events(uuid, jsonb), public.register_domain_claim(uuid, text, text, text, boolean, text, text, int, int),
                       public.regenerate_claim_token(uuid, text), public.reserve_verification_attempt(uuid, int),
                       public.archive_website(uuid), public.restart_website_claim(uuid, text, int, int),
                       public.domain_claim_status(text), public.request_domain_transfer(uuid, text, text, int),
                       public.cancel_domain_transfer(uuid), public.reserve_transfer_attempt(uuid, int),
                       public.incoming_domain_transfers(), public.contest_domain_transfer(uuid),
                       public.expire_stale_domain_claims(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_domain_claim(uuid, text, text, text, boolean, text, text, int, int),
                          public.regenerate_claim_token(uuid, text), public.reserve_verification_attempt(uuid, int),
                          public.archive_website(uuid), public.restart_website_claim(uuid, text, int, int),
                          public.domain_claim_status(text), public.request_domain_transfer(uuid, text, text, int),
                          public.cancel_domain_transfer(uuid), public.reserve_transfer_attempt(uuid, int),
                          public.incoming_domain_transfers(), public.contest_domain_transfer(uuid)
  TO wim_app;
GRANT EXECUTE ON FUNCTION public.expire_stale_domain_claims(text) TO wim_worker;

-- ---------------------------------------------------------------- Super Admin aggregates (counts only)
CREATE OR REPLACE VIEW public.admin_v_website_stats AS
SELECT
  (SELECT count(*) FROM websites WHERE archived_at IS NULL)                                   AS websites_total,
  (SELECT count(*) FROM websites WHERE status = 'ACTIVE')                                     AS websites_verified,
  (SELECT count(*) FROM websites WHERE status = 'PENDING_VERIFICATION')                       AS websites_unverified,
  (SELECT count(*) FROM websites WHERE archived_at IS NOT NULL)                               AS websites_archived,
  (SELECT count(*) FROM websites WHERE created_at > now() - interval '7 days')                AS websites_added_7d,
  (SELECT count(*) FROM domain_claims WHERE status = 'PENDING' AND pending_expires_at > now()) AS claims_pending,
  (SELECT count(*) FROM domain_claims WHERE status = 'VERIFIED')                              AS claims_verified,
  (SELECT count(*) FROM domain_claims WHERE status = 'VERIFIED' AND scope = 'ROOT')           AS claims_root_scope,
  (SELECT count(*) FROM domain_claims WHERE status = 'EXPIRED'
                                         OR (status = 'PENDING' AND pending_expires_at <= now())) AS claims_expired,
  (SELECT count(*) FROM domain_verifications WHERE status = 'SUCCEEDED' AND method = 'DNS_TXT')         AS verifications_dns,
  (SELECT count(*) FROM domain_verifications WHERE status = 'SUCCEEDED' AND method = 'WELL_KNOWN_FILE') AS verifications_file,
  (SELECT count(*) FROM domain_verifications WHERE status = 'SUCCEEDED' AND method = 'HTML_META')       AS verifications_meta,
  (SELECT count(*) FROM domain_verifications WHERE status = 'FAILED' AND requested_at > now() - interval '24 hours') AS verifications_failed_24h,
  (SELECT count(*) FROM site_installations si JOIN websites w ON w.id = si.website_id
    WHERE w.archived_at IS NULL AND si.last_seen_at IS NULL)                                   AS sdk_not_installed,
  (SELECT count(*) FROM site_installations si JOIN websites w ON w.id = si.website_id
    WHERE w.archived_at IS NULL AND si.last_seen_at > now() - interval '24 hours')            AS sdk_seen_24h,
  (SELECT count(*) FROM site_installations si JOIN websites w ON w.id = si.website_id
    WHERE w.archived_at IS NULL AND si.last_seen_at <= now() - interval '24 hours')           AS sdk_inactive,
  (SELECT count(*) FROM site_installations si JOIN websites w ON w.id = si.website_id
    WHERE w.archived_at IS NULL AND si.last_invalid_at > now() - interval '24 hours'
      AND (si.last_seen_at IS NULL OR si.last_invalid_at > si.last_seen_at))                  AS sdk_invalid_configuration,
  (SELECT count(*) FROM trials)                                                               AS trials_activated_total,
  (SELECT count(*) FROM trials WHERE created_at > now() - interval '7 days')                  AS trials_activated_7d,
  (SELECT count(*) FROM trials WHERE status = 'ACTIVE' AND ends_at > now())                   AS trials_active,
  (SELECT count(*) FROM domain_trial_ledger WHERE trial_consumed_at IS NOT NULL)              AS domains_trial_consumed,
  (SELECT count(*) FROM domain_registration_attempts WHERE outcome LIKE 'DUPLICATE%' AND outcome <> 'DUPLICATE_OWN'
                                                       AND created_at > now() - interval '24 hours') AS duplicate_attempts_24h,
  (SELECT count(*) FROM domain_registration_attempts WHERE outcome LIKE 'DUPLICATE%' AND outcome <> 'DUPLICATE_OWN'
                                                       AND created_at > now() - interval '30 days')  AS duplicate_attempts_30d,
  (SELECT count(*) FROM domain_registration_attempts WHERE outcome = 'BLOCKED' AND created_at > now() - interval '30 days') AS blocked_attempts_30d,
  (SELECT count(*) FROM (SELECT org_id FROM domain_registration_attempts
                          WHERE outcome IN ('DUPLICATE', 'DUPLICATE_NAMESPACE', 'BLOCKED', 'LIMIT') AND created_at > now() - interval '24 hours'
                          GROUP BY org_id HAVING count(*) >= 5) s)                             AS suspicious_orgs_24h,
  (SELECT count(*) FROM domain_transfers WHERE status = 'PENDING_VERIFICATION')               AS transfers_pending_verification,
  (SELECT count(*) FROM domain_transfers WHERE status = 'PENDING_ADMIN')                      AS transfers_pending_admin,
  (SELECT count(*) FROM domain_transfers WHERE status = 'APPROVED')                           AS transfers_approved,
  (SELECT count(*) FROM domain_transfers WHERE status = 'REJECTED')                           AS transfers_rejected,
  (SELECT count(*) FROM domain_transfers WHERE status = 'CANCELLED')                          AS transfers_cancelled;

CREATE OR REPLACE VIEW public.admin_v_registration_daily AS
SELECT d::date AS day,
       (SELECT count(*) FROM domain_registration_attempts a WHERE a.created_at >= d AND a.created_at < d + interval '1 day' AND a.outcome IN ('ACCEPTED', 'INHERITED_VERIFIED')) AS accepted,
       (SELECT count(*) FROM domain_registration_attempts a WHERE a.created_at >= d AND a.created_at < d + interval '1 day' AND a.outcome IN ('DUPLICATE', 'DUPLICATE_NAMESPACE')) AS duplicates,
       (SELECT count(*) FROM domain_claims c WHERE c.verified_at >= d AND c.verified_at < d + interval '1 day') AS verified
  FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d;

-- Transfer review queue: domain and org metadata only (no website content, no telemetry).
CREATE OR REPLACE VIEW public.admin_v_domain_transfers AS
SELECT t.id, r.display_host, r.registrable_domain, t.status::text AS status, t.owner_response, t.owner_respond_by,
       t.created_at, t.verified_at, t.decided_at, t.decision_reason,
       t.from_org_id, fo.name AS from_org_name, t.to_org_id, too.name AS to_org_name,
       fc.status::text AS current_claim_status, fc.verified_at AS current_claim_verified_at
  FROM domain_transfers t
  JOIN domain_registry r ON r.id = t.domain_registry_id
  LEFT JOIN organizations fo ON fo.id = t.from_org_id
  LEFT JOIN organizations too ON too.id = t.to_org_id
  LEFT JOIN domain_claims fc ON fc.id = t.from_claim_id;

GRANT SELECT ON public.admin_v_website_stats, public.admin_v_registration_daily, public.admin_v_domain_transfers TO wim_admin, wim_readonly;
