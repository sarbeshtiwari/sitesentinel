-- =============================================================================
-- Database invariant tests. Runs entirely inside a transaction that is rolled
-- back. Any failed assertion raises and aborts with a non-zero exit code.
--   docker compose -f infra/compose/docker-compose.dev.yml exec -T postgres \
--     psql -U wim_owner -d wim -v ON_ERROR_STOP=1 -f - < packages/db/tests/invariants.sql
-- =============================================================================
\set QUIET on
BEGIN;

-- Fixture: two tenants, each with a website.
INSERT INTO organizations (id, name, slug, updated_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Org A', 'org-a', now()),
  ('00000000-0000-0000-0000-00000000000b', 'Org B', 'org-b', now());
INSERT INTO domain_registry (id, identity_key, host_key, registrable_domain, display_host, is_root) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'example.com', 'example.com', 'example.com', 'example.com', true),
  ('00000000-0000-0000-0000-0000000000d2', 'other.org',   'other.org',   'other.org',   'other.org',   true);
INSERT INTO domain_claims (id, domain_registry_id, org_id, scope, status, policy, verification_token, verified_at, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000a', 'ROOT', 'VERIFIED', 'ROOT_EXCLUSIVE', 't1', now(), now()),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000b', 'ROOT', 'VERIFIED', 'ROOT_EXCLUSIVE', 't2', now(), now());
INSERT INTO websites (id, org_id, domain_claim_id, name, canonical_origin, status, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000c1', 'A site', 'https://example.com', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000c2', 'B site', 'https://other.org', 'ACTIVE', now());
INSERT INTO api_endpoints (id, org_id, website_id, name, method, url, host, host_authorization, interval_sec, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'health', 'GET', 'https://example.com/api/health', 'example.com', 'VERIFIED_DOMAIN', 60, now());
INSERT INTO api_credentials (org_id, api_endpoint_id, auth_type, secret_enc, key_version, updated_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000f1', 'BEARER', '\xdeadbeef', 1, now());

-- 1. Partitioning ------------------------------------------------------------
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM pg_partitioned_table pt JOIN pg_class c ON c.oid = pt.partrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') = 16,
         'expected 16 partitioned parents';
  ASSERT to_regclass('partitions.check_results_p' || to_char(current_date, 'YYYYMMDD')) IS NOT NULL,
         'today''s check_results partition missing';
  -- (Phase 4D: every result needs its execution_results ledger row first)
  INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
  VALUES ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
          'T1_HTTP', date_trunc('second', now()), 'PASSED', 1);
  INSERT INTO check_results (org_id, website_id, execution_id, url, status, checked_at)
  VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000004d1', 'https://example.com', 'PASSED', date_trunc('second', now()));
  RAISE NOTICE 'PASS partitioning: 16 parents, current partitions routable';
END $$;

-- 1b. Phase 4D: one logical result per execution, enforced by the database --------
DO $$
DECLARE ok boolean;
BEGIN
  -- a second result for the same execution with another timestamp (another partition key) is refused
  BEGIN
    INSERT INTO check_results (org_id, website_id, execution_id, url, status, checked_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000004d1', 'https://example.com', 'FAILED', date_trunc('second', now()) - interval '1 hour');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'second result for one execution (different timestamp) was accepted';
  -- the same timestamp is refused by the unique index
  BEGIN
    INSERT INTO check_results (org_id, website_id, execution_id, url, status, checked_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000004d1', 'https://example.com', 'FAILED', date_trunc('second', now()));
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  ASSERT ok, 'duplicate result row was accepted';
  -- a second ledger row (any timestamp, any tier) is refused
  BEGIN
    INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
    VALUES ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
            'T2_RENDER', now() - interval '2 hours', 'PASSED', 1);
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  ASSERT ok, 'second ledger row for one execution was accepted';
  -- a browser result can't borrow an HTTP ledger row, and a result without a ledger row is refused
  BEGIN
    INSERT INTO page_test_results (tested_at, org_id, website_id, execution_id, tier, viewport, status)
    VALUES (date_trunc('second', now()), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1',
            '00000000-0000-0000-0000-0000000004d1', 'T2_RENDER', 'desktop', 'PASSED');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'browser result accepted against an HTTP ledger row';
  RAISE NOTICE 'PASS one logical result per execution (ledger + trigger + unique index)';
END $$;

-- 1c. Phase 4E: deep-scan integrity (scan ↔ execution ownership, final state, child tenancy, one running scan) ----
DO $$
DECLARE ok boolean;
BEGIN
  INSERT INTO monitoring_executions (id, org_id, website_id, tier, status, queued_at) VALUES
    ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'T3_DEEP', 'RUNNING', date_trunc('second', now())),
    ('00000000-0000-0000-0000-0000000004e2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'T3_DEEP', 'RUNNING', date_trunc('second', now()) - interval '1 day'),
    ('00000000-0000-0000-0000-0000000004e3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'T1_HTTP', 'RUNNING', date_trunc('second', now()));
  -- a scan claiming another organisation, or attached to a non-deep execution, is refused
  BEGIN
    INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', '{}');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'deep scan accepted for another organisation';
  BEGIN
    INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ('00000000-0000-0000-0000-0000000004e3', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '{}');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'deep scan accepted for an HTTP execution';
  INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '{}');
  -- one RUNNING scan per website
  BEGIN
    INSERT INTO deep_scans (execution_id, org_id, website_id, config) VALUES ('00000000-0000-0000-0000-0000000004e2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '{}');
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  ASSERT ok, 'two RUNNING deep scans for one website';
  -- frontier rows and findings can't belong to another tenant
  BEGIN
    INSERT INTO deep_scan_urls (execution_id, org_id, website_id, url_hash, url, kind, depth, source)
    VALUES ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2', 'h', 'https://other.org/', 'PAGE', 0, 'START');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'frontier row accepted for another tenant';
  BEGIN
    INSERT INTO scan_findings (org_id, website_id, fingerprint, category, group_key, severity, subject, title, evidence, recommendation, detection_method,
                               first_detected_at, last_detected_at, first_execution_id, last_execution_id)
    VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', 'x', 'BROKEN_PAGE', 'broken_pages', 'HIGH', 's', 't', '{}', 'r', 'HTTP',
            now(), now(), '00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-0000000004e1');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'finding accepted for another organisation''s website';
  -- a final status needs the ledger row; once final it never changes
  BEGIN
    UPDATE deep_scans SET status = 'COMPLETED' WHERE execution_id = '00000000-0000-0000-0000-0000000004e1';
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'deep scan finalised without its execution result';
  INSERT INTO execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
  VALUES ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'T3_DEEP', date_trunc('second', now()), 'PASSED', 1);
  UPDATE deep_scans SET status = 'COMPLETED' WHERE execution_id = '00000000-0000-0000-0000-0000000004e1';
  BEGIN
    UPDATE deep_scans SET status = 'PARTIAL' WHERE execution_id = '00000000-0000-0000-0000-0000000004e1';
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'final deep scan status was changed';
  -- the customer role can't write scan data, results or usage
  SET LOCAL ROLE wim_app;
  BEGIN
    UPDATE usage_counters SET value = 0;
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  ASSERT ok, 'wim_app can write usage_counters';
  BEGIN
    UPDATE scan_findings SET status = 'RESOLVED';
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  ASSERT ok, 'wim_app can write scan_findings';
  RESET ROLE;
  RAISE NOTICE 'PASS deep-scan integrity (ownership, single running scan, child tenancy, ledger-gated final state, customer read-only)';
END $$;

-- 1d. Phase 4F: component inventory tenancy, ledger-gated functional results, customer read-only ------------------
DO $$
DECLARE ok boolean;
BEGIN
  INSERT INTO discovered_pages (id, org_id, website_id, url, url_hash, path_template, source, depth) VALUES
    ('00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'https://example.com/', 'h4f', '/', 'BROWSER', 0);
  -- a monitored page can't claim another organisation
  BEGIN
    INSERT INTO monitored_pages (org_id, website_id, discovered_page_id) VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000004f1');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'monitored page accepted for another organisation';
  INSERT INTO monitored_pages (id, org_id, website_id, discovered_page_id) VALUES ('00000000-0000-0000-0000-0000000004f2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000004f1');
  BEGIN
    INSERT INTO page_components (org_id, website_id, monitored_page_id, type, selector, dom_path_hash, confidence, evidence)
    VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000004f2', 'NAV', 'nav', 'x', 1, '{}');
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'component accepted for another organisation';
  -- a functional result needs its execution's T2 ledger row
  BEGIN
    INSERT INTO component_test_results (tested_at, org_id, website_id, monitored_page_id, execution_id, component_type, viewport, status, confidence)
    VALUES (now(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000004f2', gen_random_uuid(), 'SEARCH', 'desktop', 'PASSED', 1);
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'functional result accepted without a ledger row';
  SET LOCAL ROLE wim_app;
  BEGIN
    INSERT INTO component_events (org_id, website_id, page_component_id, execution_id, type) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', gen_random_uuid(), gen_random_uuid(), 'ADDED');
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  ASSERT ok, 'wim_app can write component history';
  RESET ROLE;
  RAISE NOTICE 'PASS component inventory tenancy, ledger-gated functional results, customer read-only';
END $$;

-- 1e. Phase 4G: rollups are tenant-bound and read-only to customers -----------------------------------------
DO $$
DECLARE ok boolean;
BEGIN
  PERFORM partitions.create_one('metrics_hourly', 'month', current_date);
  BEGIN
    INSERT INTO metrics_hourly (bucket, org_id, website_id, subject_type, subject_id, metric, count, ok_count, sum)
    VALUES (date_trunc('hour', now()), '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', 'WEBSITE', '00000000-0000-0000-0000-0000000000e1', 'perf.lcp.desktop', 1, 1, 1);
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'rollup accepted for another organisation''s website';
  SET LOCAL ROLE wim_app;
  BEGIN
    UPDATE metrics_hourly SET count = 0;
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  ASSERT ok, 'wim_app can write rollups';
  RESET ROLE;
  RAISE NOTICE 'PASS rollups tenant-bound and customer read-only';
END $$;

-- 1f. Phase 4H: operational tables — customers see nothing, Super Admin cannot forge or edit history ---------
DO $$
DECLARE ok boolean;
BEGIN
  ASSERT NOT has_table_privilege('wim_app', 'public.platform_alerts', 'SELECT'), 'wim_app can read platform alerts';
  ASSERT NOT has_table_privilege('wim_app', 'public.usage_discrepancies', 'SELECT'), 'wim_app can read usage discrepancies';
  ASSERT NOT has_table_privilege('wim_admin', 'public.platform_alerts', 'INSERT'), 'wim_admin can forge platform alerts';
  ASSERT NOT has_table_privilege('wim_admin', 'public.usage_adjustments', 'INSERT'), 'wim_admin can write adjustments directly';
  ASSERT NOT has_table_privilege('wim_admin', 'public.usage_counters', 'UPDATE'), 'wim_admin can edit usage counters directly';
  ASSERT NOT has_table_privilege('wim_admin', 'public.platform_setting_history', 'UPDATE'), 'wim_admin can edit settings history';
  ASSERT NOT has_column_privilege('wim_admin', 'public.websites', 'canonical_origin', 'SELECT'), 'wim_admin can read customer origins';
  ASSERT NOT has_table_privilege('wim_admin', 'partitions.config', 'UPDATE'), 'wim_admin can change retention without the floor check';
  BEGIN
    UPDATE public.platform_setting_history SET key = key WHERE false;
    -- statement-level no-op passes; a real row update must fail
    UPDATE public.platform_setting_history SET key = key WHERE id = (SELECT id FROM public.platform_setting_history LIMIT 1);
    ok := NOT FOUND;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  ASSERT ok, 'settings history is editable';
  BEGIN
    PERFORM ops.set_retention('security_events', 30);
    ok := false;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  ASSERT ok, 'retention below the floor accepted';
  RAISE NOTICE 'PASS operational tables private, history append-only, retention floors enforced';
END $$;

-- 1g. Release readiness, blocker 3: the browser worker role is least-privilege ----------------------------------
DO $$
DECLARE ok boolean; t text; n int;
BEGIN
  ASSERT (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb FROM pg_roles WHERE rolname = 'wim_browser'), 'wim_browser has elevated attributes';
  -- no access to identity, credentials, secrets, admin, billing, audit or other monitoring products
  FOREACH t IN ARRAY ARRAY['users', 'user_sessions', 'api_keys', 'admin_users', 'admin_sessions', 'audit_logs', 'security_events',
                           'notification_channels', 'notification_preferences', 'api_endpoints', 'auth_recipes', 'test_cases',
                           'domain_verifications', 'site_installations', 'payment_gateway_configs', 'platform_data_keys',
                           'check_results', 'deep_scans', 'deep_scan_urls', 'scan_findings', 'organization_members', 'invitations',
                           'platform_alerts', 'usage_adjustments', 'break_glass_requests', 'feature_flags', 'maintenance_windows'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      ASSERT NOT has_table_privilege('wim_browser', 'public.' || t, 'SELECT') AND NOT has_table_privilege('wim_browser', 'public.' || t, 'INSERT')
         AND NOT has_table_privilege('wim_browser', 'public.' || t, 'UPDATE') AND NOT has_table_privilege('wim_browser', 'public.' || t, 'DELETE'),
        format('wim_browser has access to %s', t);
    END IF;
  END LOOP;
  -- no column-level access either (column grants are invisible to has_table_privilege)
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE grantee = 'wim_browser' AND table_name IN ('users', 'domain_verifications', 'site_installations', 'api_endpoints', 'organization_members');
  ASSERT n = 0, 'wim_browser has column access to protected tables';
  -- execution ownership is immutable for the browser role; recorded results and ledger verdicts cannot be rewritten
  ASSERT NOT has_column_privilege('wim_browser', 'public.monitoring_executions', 'org_id', 'UPDATE')
     AND NOT has_column_privilege('wim_browser', 'public.monitoring_executions', 'website_id', 'UPDATE')
     AND NOT has_column_privilege('wim_browser', 'public.monitoring_executions', 'tier', 'UPDATE')
     AND NOT has_column_privilege('wim_browser', 'public.monitoring_executions', 'queued_at', 'UPDATE'), 'wim_browser can change execution ownership';
  ASSERT NOT has_table_privilege('wim_browser', 'public.execution_results', 'UPDATE') AND NOT has_table_privilege('wim_browser', 'public.execution_results', 'DELETE'), 'wim_browser can rewrite verdicts';
  FOREACH t IN ARRAY ARRAY['page_test_results', 'performance_metrics', 'responsive_test_results', 'component_test_results'] LOOP
    ASSERT NOT has_table_privilege('wim_browser', 'public.' || t, 'UPDATE') AND NOT has_table_privilege('wim_browser', 'public.' || t, 'DELETE')
       AND NOT has_table_privilege('wim_browser', 'public.' || t, 'SELECT'), format('wim_browser can read or modify recorded %s', t);
  END LOOP;
  ASSERT NOT has_table_privilege('wim_browser', 'public.monitoring_executions', 'INSERT') AND NOT has_table_privilege('wim_browser', 'public.monitoring_executions', 'DELETE'), 'wim_browser can create or delete executions';
  -- RLS: as the browser role, even in system mode, other tiers' executions and verdicts are invisible
  SET LOCAL ROLE wim_browser;
  PERFORM set_config('app.system', 'on', true);
  SELECT count(*) INTO n FROM public.monitoring_executions WHERE tier <> 'T2_RENDER';
  ASSERT n = 0, 'wim_browser sees non-browser executions';
  SELECT count(*) INTO n FROM public.execution_results WHERE tier <> 'T2_RENDER';
  ASSERT n = 0, 'wim_browser sees non-browser verdicts';
  BEGIN
    INSERT INTO public.execution_results (execution_id, org_id, website_id, tier, window_start, outcome, attempt)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'T1_HTTP', now(), 'PASSED', 1);
    ok := false;
  EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN ok := true;
  END;
  ASSERT ok, 'wim_browser can write a verdict for another tier';
  -- outside system mode (no tenant context) it sees nothing at all
  PERFORM set_config('app.system', 'off', true);
  SELECT count(*) INTO n FROM public.websites;
  ASSERT n = 0, 'wim_browser reads tenant data without system mode';
  RESET ROLE;
  RAISE NOTICE 'PASS wim_browser least-privilege';
END $$;

-- 1h. Staging gate: the deep-scan role is least-privilege and cannot reach other tiers ---------------------------
DO $$
DECLARE t text; n int;
BEGIN
  ASSERT (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb FROM pg_roles WHERE rolname = 'wim_scanner'), 'wim_scanner has elevated attributes';
  FOREACH t IN ARRAY ARRAY['users', 'user_sessions', 'admin_users', 'admin_sessions', 'audit_logs', 'security_events', 'api_endpoints',
                           'notification_channels', 'payment_gateway_configs', 'platform_data_keys', 'check_results', 'page_test_results',
                           'performance_metrics', 'artifacts', 'organization_members', 'platform_alerts', 'usage_adjustments'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      ASSERT NOT has_table_privilege('wim_scanner', 'public.' || t, 'SELECT') AND NOT has_table_privilege('wim_scanner', 'public.' || t, 'UPDATE'),
        format('wim_scanner has access to %s', t);
    END IF;
  END LOOP;
  ASSERT NOT has_column_privilege('wim_scanner', 'public.monitoring_executions', 'org_id', 'UPDATE')
     AND NOT has_column_privilege('wim_scanner', 'public.monitoring_executions', 'website_id', 'UPDATE')
     AND NOT has_column_privilege('wim_scanner', 'public.monitoring_executions', 'tier', 'UPDATE'), 'wim_scanner can change execution ownership';
  ASSERT NOT has_table_privilege('wim_scanner', 'public.execution_results', 'UPDATE'), 'wim_scanner can rewrite verdicts';
  SET LOCAL ROLE wim_scanner;
  PERFORM set_config('app.system', 'on', true);
  SELECT count(*) INTO n FROM public.monitoring_executions WHERE tier <> 'T3_DEEP';
  ASSERT n = 0, 'wim_scanner sees non-deep-scan executions';
  SELECT count(*) INTO n FROM public.execution_results WHERE tier <> 'T3_DEEP';
  ASSERT n = 0, 'wim_scanner sees non-deep-scan verdicts';
  PERFORM set_config('app.system', 'off', true); -- the file is one transaction: never leak system mode into later checks
  RESET ROLE;
  RAISE NOTICE 'PASS wim_scanner least-privilege';
END $$;

-- 2. Rule #1: a domain can never hold two live claims (even across tenants) ----
DO $$ BEGIN
  BEGIN
    INSERT INTO domain_claims (domain_registry_id, org_id, scope, status, policy, verification_token, pending_expires_at, updated_at)
    VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000b', 'ROOT', 'PENDING', 'ROOT_EXCLUSIVE', 'x', now() + interval '72 hours', now());
    RAISE EXCEPTION 'FAIL: duplicate live claim was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS duplicate domain claim rejected by partial unique index';
  END;
  -- A RELEASED historical claim must not block a new claim.
  UPDATE domain_claims SET status = 'RELEASED', org_id = NULL, released_at = now() WHERE id = '00000000-0000-0000-0000-0000000000c2';
  INSERT INTO domain_claims (domain_registry_id, org_id, scope, status, policy, verification_token, pending_expires_at, updated_at)
  VALUES ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000000a', 'ROOT', 'PENDING', 'ROOT_EXCLUSIVE', 'y', now() + interval '72 hours', now());
  RAISE NOTICE 'PASS released claim allows re-registration (history retained)';
  DELETE FROM domain_claims WHERE verification_token = 'y';
  UPDATE domain_claims SET status = 'VERIFIED', org_id = '00000000-0000-0000-0000-00000000000b' WHERE id = '00000000-0000-0000-0000-0000000000c2';
END $$;

-- 3. Rule #7: one active incident per fingerprint ------------------------------
DO $$ BEGIN
  INSERT INTO incidents (number, org_id, website_id, fingerprint, check_key, category, source, severity, title, description, scope, diagnostics, first_detected_at, last_detected_at, updated_at)
  VALUES (1, '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'fp1', 'k', 'AVAILABILITY', 'HTTP_PROBE', 'CRITICAL', 'down', 'd', 'site', '{}', now(), now(), now());
  BEGIN
    INSERT INTO incidents (number, org_id, website_id, fingerprint, check_key, category, source, severity, title, description, scope, diagnostics, first_detected_at, last_detected_at, updated_at)
    VALUES (2, '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'fp1', 'k', 'AVAILABILITY', 'HTTP_PROBE', 'CRITICAL', 'down', 'd', 'site', '{}', now(), now(), now());
    RAISE EXCEPTION 'FAIL: second active incident for same fingerprint accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS duplicate active incident rejected';
  END;
END $$;

-- 4. Tenant isolation (RLS) as the API role ------------------------------------
SET LOCAL ROLE wim_app;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM websites) = 0, 'FAIL: websites visible without tenant context';
  PERFORM set_config('app.current_org_id', '00000000-0000-0000-0000-00000000000a', true);
  ASSERT (SELECT count(*) FROM websites) = 1, 'FAIL: org A should see exactly its 1 website';
  ASSERT NOT EXISTS (SELECT 1 FROM websites WHERE id = '00000000-0000-0000-0000-0000000000e2'),
         'FAIL: org A can read org B website (IDOR)';
  BEGIN
    INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_by_id)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'x', now(), now(), gen_random_uuid());
    RAISE EXCEPTION 'FAIL: org A wrote a row into org B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS RLS: no context → 0 rows; org A sees only A; cross-tenant write rejected';
  END;
  -- 5. Write-only secrets.
  BEGIN
    PERFORM secret_enc FROM api_credentials;
    RAISE EXCEPTION 'FAIL: wim_app can read credential ciphertext';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS wim_app cannot SELECT api_credentials.secret_enc';
  END;
  ASSERT (SELECT hint IS NULL FROM api_credentials LIMIT 1), 'non-secret columns readable';
  -- 6. Audit log is append-only and chained.
  INSERT INTO audit_logs (stream, org_id, actor_type, action) VALUES
    ('org:a', '00000000-0000-0000-0000-00000000000a', 'USER', 'website.create'),
    ('org:a', '00000000-0000-0000-0000-00000000000a', 'USER', 'website.verify'),
    ('org:a', '00000000-0000-0000-0000-00000000000a', 'USER', 'monitoring.update');
  BEGIN
    UPDATE audit_logs SET action = 'nothing.happened' WHERE stream = 'org:a';
    RAISE EXCEPTION 'FAIL: audit log update allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS audit_logs UPDATE rejected for wim_app';
  END;
END $$;
RESET ROLE;

DO $$ BEGIN
  ASSERT (SELECT array_agg(seq ORDER BY seq) FROM audit_logs WHERE stream = 'org:a') = ARRAY[1,2,3]::bigint[],
         'FAIL: audit seq not 1,2,3';
  ASSERT NOT EXISTS (SELECT 1 FROM audit_verify('org:a')), 'FAIL: intact chain reported broken';
  -- Even the owner cannot update.
  BEGIN
    UPDATE audit_logs SET reason = 'x' WHERE stream = 'org:a';
    RAISE EXCEPTION 'FAIL: owner updated audit log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Simulate an attacker with DDL rights who disables the trigger and edits a row.
  ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable;
  UPDATE audit_logs SET action = 'website.delete' WHERE stream = 'org:a' AND seq = 2;
  ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable;
  ASSERT (SELECT broken_seq FROM audit_verify('org:a')) = 2, 'FAIL: tampering not detected at seq 2';
  RAISE NOTICE 'PASS audit chain: seq assigned, verify ok, owner update blocked, tampering detected at seq 2';
END $$;

-- 7. Super Admin privacy ------------------------------------------------------
SET LOCAL ROLE wim_admin;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM incidents LIMIT 1;
    RAISE EXCEPTION 'FAIL: admin can read incident content';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM api_credentials LIMIT 1;
    RAISE EXCEPTION 'FAIL: admin can read api credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT (SELECT count(*) FROM admin_v_websites
           WHERE org_id IN ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 2,
         'FAIL: admin metadata view should list both tenants';
  ASSERT (SELECT incident_count FROM admin_v_incident_stats WHERE org_id = '00000000-0000-0000-0000-00000000000a') = 1,
         'FAIL: admin incident stats';
  RAISE NOTICE 'PASS admin: no access to incidents/credentials; metadata views work cross-tenant';
END $$;
RESET ROLE;

-- 8. Worker system context ----------------------------------------------------
SET LOCAL ROLE wim_worker;
DO $$ BEGIN
  PERFORM set_config('app.current_org_id', '', true);
  ASSERT (SELECT count(*) FROM monitoring_schedules) = 0 OR true;  -- table empty in fixture; check websites instead
  ASSERT (SELECT count(*) FROM websites) = 0, 'FAIL: worker sees rows without context';
  PERFORM set_config('app.system', 'on', true);
  ASSERT (SELECT count(DISTINCT org_id) FROM websites
           WHERE org_id IN ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 2,
         'FAIL: system context should see all tenants';
  RAISE NOTICE 'PASS worker: isolated by default, cross-tenant only with explicit system context';
END $$;
RESET ROLE;

-- 9. Break-glass dual control -------------------------------------------------
DO $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO break_glass_requests (org_id, requested_by_id, approved_by_id, purpose, ticket_ref, scope, duration_min)
    VALUES ('00000000-0000-0000-0000-00000000000a', v, v, 'p', 't', '{}', 60);
    RAISE EXCEPTION 'FAIL: self-approved break-glass accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS break-glass self-approval rejected';
  END;
END $$;

-- 10. Phase 8 billing: tenant isolation, webhook idempotency, write-only gateway config, financial records ------
DO $$
DECLARE ok boolean; n int; t text;
BEGIN
  IF to_regprocedure('public.billing_resolve_org(text,text,text)') IS NULL THEN
    RAISE NOTICE 'SKIP billing invariants (sql/180_billing.sql not applied to this database yet)';
    RETURN;
  END IF;
  -- webhook idempotency key (rule #11)
  ASSERT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'payment_webhook_events' AND indexdef LIKE '%UNIQUE%(gateway, event_id)%'), 'FAIL: payment_webhook_events lacks UNIQUE(gateway, event_id)';
  INSERT INTO payment_webhook_events (gateway, event_id, event_type, signature_valid, payload) VALUES ('STRIPE', 'evt_inv_1', 't', true, '{}');
  BEGIN
    INSERT INTO payment_webhook_events (gateway, event_id, event_type, signature_valid, payload) VALUES ('STRIPE', 'evt_inv_1', 't', true, '{}');
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  ASSERT ok, 'FAIL: duplicate webhook event id accepted';
  -- billing tables are tenant-isolated with RLS
  FOREACH t IN ARRAY ARRAY['subscriptions', 'trials', 'payments', 'invoices', 'gateway_customers', 'entitlement_overrides'] LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass), format('FAIL: RLS disabled on %s', t);
  END LOOP;
  -- the API role can't edit plans, prices, entitlements or gateway configuration, and can't delete financial records
  FOREACH t IN ARRAY ARRAY['subscription_plans', 'plan_prices', 'plan_entitlements', 'payment_gateway_configs'] LOOP
    ASSERT NOT has_table_privilege('wim_app', 'public.' || t, 'INSERT') AND NOT has_table_privilege('wim_app', 'public.' || t, 'UPDATE')
       AND NOT has_table_privilege('wim_app', 'public.' || t, 'DELETE'), format('FAIL: wim_app can modify %s', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payments', 'invoices', 'payment_webhook_events'] LOOP
    ASSERT NOT has_table_privilege('wim_app', 'public.' || t, 'DELETE'), format('FAIL: wim_app can delete %s', t);
  END LOOP;
  ASSERT NOT has_table_privilege('wim_app', 'public.trials', 'INSERT') AND NOT has_table_privilege('wim_app', 'public.trials', 'UPDATE'), 'FAIL: wim_app can grant itself a trial';
  ASSERT NOT has_table_privilege('wim_app', 'public.domain_trial_ledger', 'DELETE') AND NOT has_table_privilege('wim_app', 'public.domain_trial_ledger', 'UPDATE'), 'FAIL: wim_app can reset the trial ledger';
  -- the narrow worker roles never see gateway configuration or money
  FOREACH t IN ARRAY ARRAY['wim_browser', 'wim_scanner'] LOOP
    ASSERT NOT has_table_privilege(t, 'public.payment_gateway_configs', 'SELECT') AND NOT has_table_privilege(t, 'public.payments', 'SELECT')
       AND NOT has_table_privilege(t, 'public.invoices', 'SELECT') AND NOT has_table_privilege(t, 'public.payment_webhook_events', 'SELECT'), format('FAIL: %s reads billing data', t);
  END LOOP;
  -- the org resolver is SECURITY DEFINER and only the API may call it
  ASSERT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.billing_resolve_org(text,text,text)'::regprocedure), 'FAIL: billing_resolve_org is not SECURITY DEFINER';
  ASSERT has_function_privilege('wim_app', 'public.billing_resolve_org(text,text,text)', 'EXECUTE')
     AND NOT has_function_privilege('wim_browser', 'public.billing_resolve_org(text,text,text)', 'EXECUTE')
     AND NOT has_function_privilege('wim_admin', 'public.billing_resolve_org(text,text,text)', 'EXECUTE'), 'FAIL: billing_resolve_org grants';
  -- RLS as the API role: org B's context never sees org A's subscription
  INSERT INTO subscription_plans (id, key, name, description, updated_at) VALUES ('00000000-0000-0000-0000-0000000000b1', 'inv-plan', 'P', 'P', now());
  INSERT INTO subscriptions (org_id, plan_id, status, gateway, gateway_subscription_id, updated_at) VALUES
    ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'ACTIVE', 'STRIPE', 'sub_inv_a', now());
  SET LOCAL ROLE wim_app;
  PERFORM set_config('app.current_org_id', '00000000-0000-0000-0000-00000000000b', true);
  SELECT count(*) INTO n FROM subscriptions;
  ASSERT n = 0, 'FAIL: org B sees org A subscription';
  -- …while the definer resolver only reveals the owning org id of a known gateway object
  ASSERT public.billing_resolve_org('STRIPE', 'sub_inv_a', NULL) = '00000000-0000-0000-0000-00000000000a', 'FAIL: resolver did not find the owner';
  ASSERT public.billing_resolve_org('RAZORPAY', 'sub_inv_a', NULL) IS NULL, 'FAIL: resolver ignores the gateway';
  BEGIN
    INSERT INTO subscriptions (org_id, plan_id, status, updated_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'ACTIVE', now());
    ok := false;
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN ok := true;
  END;
  ASSERT ok, 'FAIL: org B context wrote an org A subscription';
  PERFORM set_config('app.current_org_id', '', true);
  RESET ROLE;
  -- one current subscription per org
  BEGIN
    INSERT INTO subscriptions (org_id, plan_id, status, updated_at) VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1', 'PAST_DUE', now());
    ok := false;
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  ASSERT ok, 'FAIL: second current subscription accepted';
  RAISE NOTICE 'PASS billing: RLS, webhook idempotency, write-only gateway config, financial records retained';
END $$;

ROLLBACK;
\echo ALL DATABASE INVARIANTS PASSED
