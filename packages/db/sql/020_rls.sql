-- =============================================================================
-- 020 — Row-level security (defense in depth; ARCHITECTURE.md §16, D-13).
--
-- Every request/job runs in a transaction that sets:
--     SET LOCAL app.current_org_id = '<uuid>';
-- Cross-tenant system processes (scheduler, maintenance, billing webhooks)
-- additionally set, and only as role wim_worker:
--     SET LOCAL app.system = 'on';
-- Runtime roles are not table owners and have NOBYPASSRLS. The owner
-- (migrations) is unaffected because RLS is ENABLEd, not FORCEd.
-- Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION public.app_is_system() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- Tables that carry org_id but are NOT tenant-isolated by RLS, with the reason:
--   audit_logs, security_events      platform-wide append-only logs; access via grants/views
--   outbox_events, job_failures      system plumbing (workers only)
--   data_requests                    processed by maintenance worker; API scopes in app layer
--   domain_registration_attempts     global abuse analysis; app writes only (no customer read endpoint)
--   roles, incident_rules,
--   api_host_authorizations          nullable org_id = platform default rows → dedicated policies below
--   domain_claims                    dedicated policy below (org_id nullable after deletion)
DO $$
DECLARE
  t text;
  excluded text[] := ARRAY[
    'audit_logs', 'security_events', 'outbox_events', 'job_failures', 'data_requests',
    'domain_registration_attempts', 'roles', 'incident_rules', 'api_host_authorizations', 'domain_claims'
  ];
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'org_id'
       AND tb.table_type = 'BASE TABLE'
       AND c.table_name <> ALL (excluded)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        USING (org_id = public.app_current_org())
        WITH CHECK (org_id = public.app_current_org())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS system_access ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY system_access ON public.%I TO wim_worker
        USING (public.app_is_system())
        WITH CHECK (public.app_is_system())$p$, t);
  END LOOP;
END $$;

-- organizations: keyed by id, not org_id.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.organizations;
CREATE POLICY tenant_isolation ON public.organizations
  USING (id = public.app_current_org()) WITH CHECK (id = public.app_current_org());
DROP POLICY IF EXISTS system_access ON public.organizations;
CREATE POLICY system_access ON public.organizations TO wim_worker
  USING (public.app_is_system()) WITH CHECK (public.app_is_system());
-- Org creation: the API generates the new org id, sets app.current_org_id to it
-- in the same transaction, then inserts the org, its owner membership and its
-- data key. WITH CHECK still applies, so no SECURITY DEFINER bypass is needed.

-- Tables with platform-default rows (org_id IS NULL): readable by all tenants, writable only for own org.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'incident_rules', 'api_host_authorizations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_read ON public.%I', t);
    EXECUTE format($p$CREATE POLICY tenant_read ON public.%I FOR SELECT
                      USING (org_id IS NULL OR org_id = public.app_current_org())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON public.%I', t);
    EXECUTE format($p$CREATE POLICY tenant_write ON public.%I FOR ALL
                      USING (org_id = public.app_current_org())
                      WITH CHECK (org_id = public.app_current_org())$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS system_access ON public.%I', t);
    EXECUTE format($p$CREATE POLICY system_access ON public.%I TO wim_worker
                      USING (public.app_is_system()) WITH CHECK (public.app_is_system())$p$, t);
  END LOOP;
END $$;

-- domain_claims: a tenant sees only its own claims. Global uniqueness is still
-- enforced across tenants because unique indexes ignore RLS. Conflict checks
-- that need other tenants' state go through SECURITY DEFINER functions that
-- return booleans only, never another org's identity (Phase 3).
ALTER TABLE public.domain_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.domain_claims;
CREATE POLICY tenant_isolation ON public.domain_claims
  USING (org_id = public.app_current_org()) WITH CHECK (org_id = public.app_current_org());
DROP POLICY IF EXISTS system_access ON public.domain_claims;
CREATE POLICY system_access ON public.domain_claims TO wim_worker
  USING (public.app_is_system()) WITH CHECK (public.app_is_system());

-- Ingest resolves a public site key to its tenant before any tenant context exists.
-- Returns only ids for ACTIVE websites; exposes nothing else.
CREATE OR REPLACE FUNCTION public.resolve_site_key(p_site_key text)
RETURNS TABLE (org_id uuid, website_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT si.org_id, si.website_id
    FROM site_installations si
    JOIN websites w ON w.id = si.website_id
   WHERE (si.site_key = p_site_key
          OR (si.previous_site_key = p_site_key AND si.previous_key_expires_at > now()))
     AND w.status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION public.resolve_site_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_site_key(text) TO wim_app;
