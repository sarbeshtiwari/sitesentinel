-- =============================================================================
-- 050 — Role grants and Super Admin views (D-12, ARCHITECTURE.md §17).
--
--  wim_app      api / realtime / ingest. Tenant CRUD under RLS. Can WRITE customer
--               secrets (api_credentials, auth_recipes, notification_channels) but
--               cannot SELECT their ciphertext columns. Prisma clients for this role
--               must `omit` those columns (packages/db client config).
--  wim_worker   scheduler + non-browser workers. Broad access under RLS/system context.
--  wim_browser  Playwright workers. Reads job config, writes results only.
--  wim_admin    admin API. NO access to tenant content tables; metadata via admin_v_* views,
--               plus write access to platform configuration tables.
--  wim_readonly BI/support replica: aggregates only.
-- Idempotent (GRANT/REVOKE are repeatable; views are CREATE OR REPLACE).
-- =============================================================================

-- Start from a clean slate for runtime roles on public tables.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wim_app, wim_worker, wim_browser, wim_admin, wim_readonly;
GRANT USAGE ON SCHEMA partitions TO wim_worker;  -- maintenance calls partitions.ensure_all()

-- ---------------------------------------------------------------- wim_app
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wim_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wim_app;
REVOKE ALL ON public.admin_users, public.admin_sessions, public.break_glass_requests,
              public.job_failures, public.worker_heartbeats, public.audit_anchors,
              public.payment_gateway_configs, public.platform_setting_history
  FROM wim_app;
GRANT SELECT ON public.payment_gateway_configs TO wim_app;      -- checkout needs gateway keys
REVOKE UPDATE, DELETE ON public.audit_logs FROM wim_app;
REVOKE UPDATE, DELETE ON public.domain_registry, public.domain_trial_ledger FROM wim_app;
GRANT UPDATE (first_verified_at) ON public.domain_registry TO wim_app;
REVOKE INSERT, UPDATE, DELETE ON public.subscription_plans, public.plan_prices, public.plan_entitlements,
                                 public.platform_settings, public.feature_flags, public.email_templates,
                                 public.blocked_domains, public.domain_policy_suffixes
  FROM wim_app;

-- Write-only secrets: column-level SELECT excluding ciphertext.
REVOKE SELECT ON public.api_credentials, public.auth_recipes, public.notification_channels FROM wim_app;
GRANT SELECT (id, org_id, api_endpoint_id, auth_type, key_version, hint, rotated_at, created_at, updated_at)
  ON public.api_credentials TO wim_app;
GRANT SELECT (id, org_id, website_id, name, login_url, steps, key_version, success_selector, created_at, updated_at)
  ON public.auth_recipes TO wim_app;
GRANT SELECT (id, org_id, kind, name, target, key_version, min_severity, verified_at, enabled, created_at)
  ON public.notification_channels TO wim_app;

-- ---------------------------------------------------------------- wim_worker
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wim_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wim_worker;
REVOKE ALL ON public.admin_users, public.admin_sessions FROM wim_worker;
REVOKE UPDATE, DELETE ON public.audit_logs FROM wim_worker;
GRANT EXECUTE ON FUNCTION partitions.ensure_all(), partitions.apply_retention() TO wim_worker;

-- "ALL TABLES" includes views. On a fresh database no view exists yet at this point, but this file re-runs on
-- every deploy, when the admin_v_* views (and extension views such as pg_stat_statements) already exist. Views
-- run with the owner's privileges and therefore bypass RLS, so the tenant roles must never hold them: without
-- this, every redeploy gave wim_app / wim_worker cross-tenant SELECT (and, through the auto-updatable
-- admin_v_usage_daily, UPDATE/DELETE of every tenant's usage counters). Admin views are granted explicitly below.
DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM wim_app, wim_worker', v.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- wim_browser
GRANT SELECT ON public.websites, public.monitoring_configurations, public.monitored_pages,
                public.discovered_pages, public.page_components, public.test_cases,
                public.auth_recipes, public.maintenance_windows, public.site_installations,
                public.monitoring_schedules, public.platform_settings, public.feature_flags
  TO wim_browser;
GRANT INSERT, UPDATE ON public.discovered_pages, public.page_components TO wim_browser;
GRANT INSERT ON public.page_test_results, public.component_test_results, public.responsive_test_results,
                public.performance_metrics, public.check_results, public.artifacts,
                public.domain_verifications, public.worker_heartbeats
  TO wim_browser;
GRANT UPDATE ON public.worker_heartbeats TO wim_browser;
GRANT UPDATE (status, worker_id, started_at, finished_at, duration_ms, summary, error_code, error_message, attempt)
  ON public.monitoring_executions TO wim_browser;
GRANT SELECT (id, queued_at, org_id, website_id, status) ON public.monitoring_executions TO wim_browser;
GRANT UPDATE (status, completed_at, failure_reason, detail) ON public.domain_verifications TO wim_browser;
GRANT SELECT (id, domain_claim_id, method, status) ON public.domain_verifications TO wim_browser;
GRANT UPDATE (status, sdk_version, first_seen_at, last_seen_at) ON public.site_installations TO wim_browser;
-- wim_browser has tenant_isolation policies only (no system_access), so it always works inside one org.

-- ---------------------------------------------------------------- wim_admin
-- Platform configuration (read/write).
GRANT SELECT, INSERT, UPDATE ON public.subscription_plans, public.plan_prices, public.plan_entitlements,
                                public.entitlement_overrides, public.platform_settings, public.platform_setting_history,
                                public.feature_flags, public.email_templates, public.blocked_domains,
                                public.domain_policy_suffixes, public.incident_rules, public.break_glass_requests,
                                public.admin_users, public.admin_sessions, public.job_failures,
                                public.domain_transfers, public.api_host_authorizations
  TO wim_admin;
GRANT DELETE ON public.entitlement_overrides, public.blocked_domains, public.domain_policy_suffixes,
                public.admin_sessions
  TO wim_admin;
GRANT SELECT, UPDATE ON public.payment_gateway_configs, public.domain_trial_ledger TO wim_admin;
GRANT INSERT ON public.payment_gateway_configs TO wim_admin;
GRANT SELECT ON public.domain_registry, public.domain_registration_attempts, public.worker_heartbeats,
                public.payment_webhook_events, public.audit_logs, public.audit_anchors,
                public.security_events, public.system_health_logs, public.permissions, public.roles
  TO wim_admin;
GRANT INSERT ON public.audit_logs TO wim_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wim_admin;
-- Admin account actions on tenant metadata, column-scoped.
GRANT UPDATE (status, suspended_reason) ON public.organizations TO wim_admin;
GRANT UPDATE (status, suspended_reason) ON public.websites TO wim_admin;
GRANT UPDATE (ends_at, extended_days, extended_by_id, status) ON public.trials TO wim_admin;
-- Admin RLS bypass for the tables above happens only through views and the
-- column grants; tenant tables keep RLS, so give wim_admin a metadata policy:
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations', 'websites', 'trials', 'entitlement_overrides', 'incident_rules', 'api_host_authorizations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_metadata ON public.%I', t);
    EXECUTE format('CREATE POLICY admin_metadata ON public.%I TO wim_admin USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT (id, name, slug, status, timezone, currency, suspended_reason, deletion_requested_at, created_at, updated_at)
  ON public.organizations TO wim_admin;
GRANT SELECT (id, org_id, name, canonical_origin, status, health_score, health_band, current_state,
              last_checked_at, created_at, archived_at, suspended_reason)
  ON public.websites TO wim_admin;
GRANT SELECT ON public.trials, public.entitlement_overrides TO wim_admin;

-- Masked email for admin display: j***@e***.com
CREATE OR REPLACE FUNCTION public.mask_email(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_email IS NULL OR position('@' IN p_email) = 0 THEN NULL ELSE
    left(split_part(p_email, '@', 1), 1) || '***@' ||
    left(split_part(p_email, '@', 2), 1) || '***' ||
    coalesce('.' || nullif(reverse(split_part(reverse(split_part(p_email, '@', 2)), '.', 1)), ''), '')
  END
$$;

-- Views run with the owner's privileges (security_invoker = false), so they read
-- across tenants — but expose only the metadata columns listed here.
CREATE OR REPLACE VIEW public.admin_v_organizations AS
SELECT o.id, o.name, o.slug, o.status, o.created_at, o.deletion_requested_at,
       sp.key AS plan_key, s.status AS subscription_status, s.current_period_end,
       t.status AS trial_status, t.ends_at AS trial_ends_at,
       (SELECT count(*) FROM organization_members m WHERE m.org_id = o.id) AS member_count,
       (SELECT count(*) FROM websites w WHERE w.org_id = o.id AND w.archived_at IS NULL) AS website_count,
       (SELECT public.mask_email(u.email::text)
          FROM organization_members m JOIN roles r ON r.id = m.role_id JOIN users u ON u.id = m.user_id
         WHERE m.org_id = o.id AND r.key = 'OWNER' ORDER BY m.created_at LIMIT 1) AS owner_email_masked
  FROM organizations o
  LEFT JOIN subscriptions s ON s.org_id = o.id AND s.status NOT IN ('CANCELED', 'EXPIRED')
  LEFT JOIN subscription_plans sp ON sp.id = s.plan_id
  LEFT JOIN trials t ON t.org_id = o.id;

CREATE OR REPLACE VIEW public.admin_v_websites AS
SELECT w.id, w.org_id, dr.display_host, dr.registrable_domain, w.status, dc.status AS claim_status,
       dc.verified_at, w.health_score, w.current_state, w.last_checked_at, w.created_at,
       si.status AS installation_status,
       (SELECT count(*) FROM monitored_pages p WHERE p.website_id = w.id AND p.status = 'ACTIVE') AS monitored_page_count,
       (SELECT count(*) FROM api_endpoints a WHERE a.website_id = w.id) AS api_endpoint_count,
       (SELECT count(*) FROM incidents i WHERE i.website_id = w.id
         AND i.status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED')) AS open_incident_count
  FROM websites w
  JOIN domain_claims dc ON dc.id = w.domain_claim_id
  JOIN domain_registry dr ON dr.id = dc.domain_registry_id
  LEFT JOIN site_installations si ON si.website_id = w.id;

-- Incident counts only — never titles, descriptions or diagnostics.
CREATE OR REPLACE VIEW public.admin_v_incident_stats AS
SELECT org_id, category, severity, status, count(*) AS incident_count,
       max(last_detected_at) AS last_detected_at
  FROM incidents
 GROUP BY org_id, category, severity, status;

CREATE OR REPLACE VIEW public.admin_v_execution_stats AS
SELECT date_trunc('hour', queued_at) AS hour, tier, status, count(*) AS executions,
       avg(duration_ms)::int AS avg_duration_ms
  FROM monitoring_executions
 WHERE queued_at > now() - interval '7 days'
 GROUP BY 1, 2, 3;

GRANT SELECT ON public.admin_v_organizations, public.admin_v_websites,
                public.admin_v_incident_stats, public.admin_v_execution_stats
  TO wim_admin, wim_readonly;
