-- =============================================================================
-- 060 — Identity lookups that must cross tenants, plus Super Admin aggregates.
--
-- RLS hides every org's rows unless app.current_org_id is set. A few identity
-- flows legitimately start without an org context; each gets a narrow
-- SECURITY DEFINER function that returns only what that flow needs. None of
-- them can be used to enumerate other tenants' data.
-- Idempotent. Runs after 050 (which resets grants), so grants here persist.
-- =============================================================================

-- The orgs a user belongs to (org switcher, GET /orgs, /me). Keyed by the
-- session's user id, which the API takes from the verified session only.
CREATE OR REPLACE FUNCTION public.user_memberships(p_user_id uuid)
RETURNS TABLE (org_id uuid, org_name text, org_slug text, org_status text, member_id uuid,
               role_id uuid, role_key text, role_name text, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name, o.slug, o.status::text, m.id, r.id, r.key, r.name, m.created_at
    FROM organization_members m
    JOIN organizations o ON o.id = m.org_id
    JOIN roles r ON r.id = m.role_id
   WHERE m.user_id = p_user_id
   ORDER BY m.created_at
$$;

-- Resolve an invitation from the hash of its token (the raw token exists only in
-- the emailed link). Knowing the hash requires knowing the 256-bit token.
CREATE OR REPLACE FUNCTION public.invitation_by_token_hash(p_token_hash text)
RETURNS TABLE (id uuid, org_id uuid, org_name text, email text, role_id uuid, role_name text,
               status text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.org_id, o.name, i.email::text, i.role_id, r.name, i.status::text, i.expires_at
    FROM invitations i
    JOIN organizations o ON o.id = i.org_id
    JOIN roles r ON r.id = i.role_id
   WHERE i.token_hash = p_token_hash
$$;

-- Pending invitations addressed to a (verified) email: GET /me/invitations.
CREATE OR REPLACE FUNCTION public.pending_invitations_for_email(p_email citext)
RETURNS TABLE (id uuid, org_id uuid, org_name text, role_name text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.org_id, o.name, r.name, i.expires_at
    FROM invitations i
    JOIN organizations o ON o.id = i.org_id
    JOIN roles r ON r.id = i.role_id
   WHERE i.email = p_email AND i.status = 'PENDING' AND i.expires_at > now()
   ORDER BY i.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.user_memberships(uuid), public.invitation_by_token_hash(text),
                       public.pending_invitations_for_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_memberships(uuid), public.invitation_by_token_hash(text),
                          public.pending_invitations_for_email(citext) TO wim_app;
GRANT EXECUTE ON FUNCTION public.invitation_by_token_hash(text) TO wim_worker;

-- ---------------------------------------------------------------- admin aggregates
-- Platform-wide counts only. No row of any customer table is exposed.
CREATE OR REPLACE VIEW public.admin_v_platform_stats AS
SELECT
  (SELECT count(*) FROM users WHERE status <> 'DELETED')                                  AS users_total,
  (SELECT count(*) FROM users WHERE email_verified_at IS NOT NULL AND status <> 'DELETED') AS users_verified,
  (SELECT count(*) FROM users WHERE totp_enabled_at IS NOT NULL AND status <> 'DELETED')   AS users_with_2fa,
  (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')                AS signups_7d,
  (SELECT count(*) FROM users WHERE created_at > now() - interval '30 days')               AS signups_30d,
  (SELECT count(*) FROM organizations)                                                      AS orgs_total,
  (SELECT count(*) FROM organizations WHERE status = 'ACTIVE')                              AS orgs_active,
  (SELECT count(*) FROM organizations WHERE status = 'SUSPENDED')                           AS orgs_suspended,
  (SELECT count(*) FROM organizations WHERE status = 'PENDING_DELETION')                    AS orgs_pending_deletion,
  (SELECT count(*) FROM subscriptions WHERE status = 'TRIALING')                            AS subs_trialing,
  (SELECT count(*) FROM subscriptions WHERE status IN ('ACTIVE', 'CANCELING'))              AS subs_paid,
  (SELECT count(*) FROM subscriptions WHERE status = 'PAST_DUE')                            AS subs_past_due,
  (SELECT count(*) FROM subscriptions WHERE status = 'EXPIRED')                             AS subs_expired,
  (SELECT count(*) FROM websites WHERE archived_at IS NULL)                                 AS websites_total,
  (SELECT count(*) FROM websites WHERE status = 'ACTIVE')                                   AS websites_active,
  (SELECT count(*) FROM websites WHERE status = 'PENDING_VERIFICATION')                     AS websites_pending,
  (SELECT count(*) FROM incidents WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED')) AS incidents_open,
  (SELECT count(*) FROM incidents WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED')
                                     AND severity = 'CRITICAL')                             AS incidents_open_critical,
  (SELECT count(*) FROM monitoring_executions WHERE queued_at > now() - interval '24 hours') AS executions_24h,
  (SELECT count(*) FROM monitoring_executions WHERE queued_at > now() - interval '24 hours'
                                               AND status IN ('FAILED', 'TIMED_OUT'))       AS executions_failed_24h,
  (SELECT count(*) FROM job_failures WHERE resolved_at IS NULL)                             AS job_failures_unresolved,
  (SELECT count(*) FROM worker_heartbeats WHERE last_seen_at > now() - interval '30 seconds') AS workers_healthy,
  (SELECT count(*) FROM worker_heartbeats)                                                  AS workers_total;

CREATE OR REPLACE VIEW public.admin_v_signups_daily AS
SELECT d::date AS day,
       (SELECT count(*) FROM users u WHERE u.created_at >= d AND u.created_at < d + interval '1 day') AS signups
  FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d;

GRANT SELECT ON public.admin_v_platform_stats, public.admin_v_signups_daily TO wim_admin, wim_readonly;

-- Admin authentication writes its own login history and security events.
GRANT INSERT ON public.login_attempts, public.security_events TO wim_admin;
GRANT SELECT, INSERT ON public.platform_data_keys TO wim_admin;
GRANT SELECT ON public.platform_settings TO wim_app, wim_worker;

-- ---------------------------------------------------------------- user-scoped RLS
-- Per-user rows are isolated at the database level too. The API runs user-scoped
-- statements in a transaction with:  SET LOCAL app.current_user_id = '<uuid>'.
CREATE OR REPLACE FUNCTION public.app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_sessions', 'recovery_codes', 'account_recovery_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS user_isolation ON public.%I', t);
    EXECUTE format($p$CREATE POLICY user_isolation ON public.%I
                      USING (user_id = public.app_current_user())
                      WITH CHECK (user_id = public.app_current_user())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS system_access ON public.%I', t);
    EXECUTE format($p$CREATE POLICY system_access ON public.%I TO wim_worker
                      USING (public.app_is_system()) WITH CHECK (public.app_is_system())$p$, t);
  END LOOP;
END $$;

-- notifications / notification_preferences also carry org_id (tenant policy from 020);
-- add the user condition so a member never reads a colleague's notifications.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I
                      USING (org_id = public.app_current_org() AND user_id = public.app_current_user())
                      WITH CHECK (org_id = public.app_current_org() AND user_id = public.app_current_user())$p$, t);
  END LOOP;
END $$;

-- Session lookup by token hash happens before the user is known (every request).
-- Returns the one session matching a 256-bit token's hash, with the user fields the
-- guard needs. Knowing a hash requires knowing the token.
CREATE OR REPLACE FUNCTION public.session_lookup(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, mfa_verified boolean, csrf_secret text, created_at timestamptz,
               last_seen_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
               user_status text, email text, email_verified boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.user_id, s.mfa_verified, s.csrf_secret, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
         u.status::text, u.email::text, u.email_verified_at IS NOT NULL
    FROM user_sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION public.session_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_lookup(text) TO wim_app;

-- ---------------------------------------------------------------- audit log read isolation
-- Inserts are open to the runtime roles (auth events happen before any context);
-- reads are limited to the caller's org stream or own user stream.
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_insert ON public.audit_logs;
CREATE POLICY audit_insert ON public.audit_logs FOR INSERT TO wim_app, wim_worker, wim_admin WITH CHECK (true);
DROP POLICY IF EXISTS audit_read_own ON public.audit_logs;
CREATE POLICY audit_read_own ON public.audit_logs FOR SELECT TO wim_app
  USING ((org_id IS NOT NULL AND org_id = public.app_current_org())
         OR stream = 'user:' || public.app_current_user()::text);
DROP POLICY IF EXISTS audit_read_admin ON public.audit_logs;
CREATE POLICY audit_read_admin ON public.audit_logs FOR SELECT TO wim_admin USING (true);
DROP POLICY IF EXISTS audit_read_system ON public.audit_logs;
CREATE POLICY audit_read_system ON public.audit_logs FOR SELECT TO wim_worker USING (public.app_is_system());

-- ---------------------------------------------------------------- membership-checked tenant entry
-- The customer API enters a tenant context ONLY through this function, so the
-- database itself refuses org access for non-members or members lacking the
-- permission — even if an application-level guard were bypassed by a bug.
CREATE OR REPLACE FUNCTION public.app_enter_org(p_org_id uuid, p_user_id uuid, p_permission text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role_id uuid;
  v_role_key text;
BEGIN
  SELECT m.role_id, r.key INTO v_role_id, v_role_key
    FROM organization_members m JOIN roles r ON r.id = m.role_id
   WHERE m.org_id = p_org_id AND m.user_id = p_user_id;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'wim:not_member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM role_permissions WHERE role_id = v_role_id AND permission_key = p_permission) THEN
    RAISE EXCEPTION 'wim:missing_permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.current_org_id', p_org_id::text, true);
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  RETURN v_role_key;
END $$;
REVOKE ALL ON FUNCTION public.app_enter_org(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_enter_org(uuid, uuid, text) TO wim_app;

-- Resolve a lost-2FA recovery request from an emailed confirm/cancel token hash
-- (the user is not signed in when clicking the link). Returns ids only.
CREATE OR REPLACE FUNCTION public.recovery_request_by_token(p_token_hash text)
RETURNS TABLE (id uuid, user_id uuid, token_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.user_id, CASE WHEN r.confirm_token_hash = p_token_hash THEN 'CONFIRM' ELSE 'CANCEL' END
    FROM account_recovery_requests r
   WHERE r.confirm_token_hash = p_token_hash OR r.cancel_token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION public.recovery_request_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recovery_request_by_token(text) TO wim_app;

-- ---------------------------------------------------------------- role integrity (DB-level authorization)
-- role_permissions has no org_id of its own: scope it through its role, so the API
-- can read system + own-org role permissions, and can only modify its own org's
-- custom roles. System role permissions are changeable only by the schema owner (seed).
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_scope_read ON public.role_permissions;
CREATE POLICY role_scope_read ON public.role_permissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND (r.org_id IS NULL OR r.org_id = public.app_current_org())));
DROP POLICY IF EXISTS role_scope_write ON public.role_permissions;
CREATE POLICY role_scope_write ON public.role_permissions FOR ALL
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.org_id = public.app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.org_id = public.app_current_org()));
DROP POLICY IF EXISTS system_access ON public.role_permissions;
CREATE POLICY system_access ON public.role_permissions TO wim_worker
  USING (public.app_is_system()) WITH CHECK (public.app_is_system());

-- Custom roles can never carry owner-only permissions, whatever the application does.
CREATE OR REPLACE FUNCTION public.role_permissions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.permission_key IN ('org:delete', 'org:transfer_ownership', 'billing:manage', 'data:export')
     AND EXISTS (SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND NOT r.is_system) THEN
    RAISE EXCEPTION 'owner-only permission % cannot be granted to a custom role', NEW.permission_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS role_permissions_guard ON public.role_permissions;
CREATE TRIGGER role_permissions_guard BEFORE INSERT OR UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.role_permissions_guard();

-- A membership or invitation may only reference a system role or a role of the same org.
CREATE OR REPLACE FUNCTION public.role_in_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND (r.org_id IS NULL OR r.org_id = NEW.org_id)) THEN
    RAISE EXCEPTION 'role % does not belong to organization %', NEW.role_id, NEW.org_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS organization_members_role_guard ON public.organization_members;
CREATE TRIGGER organization_members_role_guard BEFORE INSERT OR UPDATE OF role_id ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.role_in_org_guard();
DROP TRIGGER IF EXISTS invitations_role_guard ON public.invitations;
CREATE TRIGGER invitations_role_guard BEFORE INSERT OR UPDATE OF role_id ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.role_in_org_guard();

-- An organization always keeps at least one OWNER (checked at commit, so ownership
-- transfer inside one transaction works).
CREATE OR REPLACE FUNCTION public.org_keeps_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid := COALESCE(OLD.org_id, NEW.org_id);
BEGIN
  IF EXISTS (SELECT 1 FROM organizations WHERE id = v_org)
     AND NOT EXISTS (SELECT 1 FROM organization_members m JOIN roles r ON r.id = m.role_id
                      WHERE m.org_id = v_org AND r.key = 'OWNER' AND r.org_id IS NULL) THEN
    RAISE EXCEPTION 'organization % must keep at least one owner', v_org USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS organization_members_keep_owner ON public.organization_members;
CREATE CONSTRAINT TRIGGER organization_members_keep_owner AFTER UPDATE OR DELETE ON public.organization_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.org_keeps_owner();

-- Resolve an invitation by id for its invitee only (accept from "my invitations").
-- The email binding is enforced here, not just in the application.
CREATE OR REPLACE FUNCTION public.invitation_for_invitee(p_invitation_id uuid, p_email citext)
RETURNS TABLE (id uuid, org_id uuid, org_name text, email text, role_id uuid, role_name text,
               status text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.org_id, o.name, i.email::text, i.role_id, r.name, i.status::text, i.expires_at
    FROM invitations i
    JOIN organizations o ON o.id = i.org_id
    JOIN roles r ON r.id = i.role_id
   WHERE i.id = p_invitation_id AND i.email = p_email
$$;
REVOKE ALL ON FUNCTION public.invitation_for_invitee(uuid, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invitation_for_invitee(uuid, citext) TO wim_app;
