-- =============================================================================
-- 030 — Constraints Prisma cannot express: partial unique indexes, CHECKs.
-- These are the database-level guarantees behind product rules #1, #7 and
-- billing integrity (ARCHITECTURE.md §11.3, §10.3). Idempotent.
-- =============================================================================

-- Rule #1: a website identity can have at most one live claim, across ALL tenants.
CREATE UNIQUE INDEX IF NOT EXISTS domain_claims_one_live_claim
  ON public.domain_claims (domain_registry_id)
  WHERE status IN ('PENDING', 'VERIFIED', 'LAPSED');

-- Rule #7: one active incident per fingerprint per org (grouping holds even if the Redis lock fails).
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_active_per_fingerprint
  ON public.incidents (org_id, fingerprint)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'REOPENED');

-- One current subscription per org.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_current_per_org
  ON public.subscriptions (org_id)
  WHERE status NOT IN ('CANCELED', 'EXPIRED');

-- System roles (org_id NULL) have unique keys (the composite unique treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS roles_system_key
  ON public.roles (key) WHERE org_id IS NULL;

-- Website-level schedules (api_endpoint_id NULL): one per (website, tier).
CREATE UNIQUE INDEX IF NOT EXISTS monitoring_schedules_website_tier
  ON public.monitoring_schedules (website_id, tier) WHERE api_endpoint_id IS NULL;

-- Incident rules: one platform default per category, one org default per category.
CREATE UNIQUE INDEX IF NOT EXISTS incident_rules_platform_default
  ON public.incident_rules (category) WHERE org_id IS NULL AND website_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS incident_rules_org_default
  ON public.incident_rules (org_id, category) WHERE org_id IS NOT NULL AND website_id IS NULL;

-- Platform-wide API host allowlist entries are unique by host.
CREATE UNIQUE INDEX IF NOT EXISTS api_host_authorizations_platform_host
  ON public.api_host_authorizations (host) WHERE org_id IS NULL;

-- Scheduler hot path: due ACTIVE schedules only.
CREATE INDEX IF NOT EXISTS monitoring_schedules_due
  ON public.monitoring_schedules (next_run_at) WHERE status = 'ACTIVE';

-- Outbox relay hot path.
CREATE INDEX IF NOT EXISTS outbox_events_unpublished
  ON public.outbox_events (id) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- CHECK constraints (added only if missing)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.add_check(p_table text, p_name text, p_expr text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p_name) THEN
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', p_table, p_name, p_expr);
  END IF;
END $$;

-- Phase 4C: t1_interval_sec became nullable (NULL = entitled default); replace the Phase 1 form of this check.
ALTER TABLE public.monitoring_configurations DROP CONSTRAINT IF EXISTS mc_intervals_min;
SELECT pg_temp.add_check('monitoring_configurations', 'mc_intervals_min',
  '(t1_interval_sec IS NULL OR t1_interval_sec >= 30) AND (t2_interval_sec IS NULL OR t2_interval_sec >= 300) AND (t3_interval_sec IS NULL OR t3_interval_sec >= 900)');
-- Phase 4E: max_pages / max_depth are nullable (NULL = plan limit); replace the Phase 1 form of this check.
ALTER TABLE public.monitoring_configurations DROP CONSTRAINT IF EXISTS mc_crawl_bounds;
SELECT pg_temp.add_check('monitoring_configurations', 'mc_crawl_bounds',
  '(max_pages IS NULL OR max_pages BETWEEN 1 AND 100000) AND (max_depth IS NULL OR max_depth BETWEEN 0 AND 50)');
SELECT pg_temp.add_check('monitoring_schedules', 'ms_interval_positive', 'interval_sec >= 30 AND jitter_sec >= 0 AND jitter_sec < interval_sec');
SELECT pg_temp.add_check('api_endpoints', 'api_timeout_bounds', 'timeout_ms BETWEEN 100 AND 60000 AND retry_count BETWEEN 0 AND 5');
SELECT pg_temp.add_check('plan_prices', 'plan_price_amount', 'amount_minor >= 0 AND currency = upper(currency)');
SELECT pg_temp.add_check('incident_rules', 'ir_thresholds', 'failure_threshold >= 1 AND recovery_passes >= 1 AND window_sec > 0');
SELECT pg_temp.add_check('incidents', 'incident_counts', 'occurrence_count >= 1 AND reopen_count >= 0');
SELECT pg_temp.add_check('page_components', 'pc_confidence', 'confidence >= 0 AND confidence <= 1');
SELECT pg_temp.add_check('websites', 'website_health_range', 'health_score IS NULL OR health_score BETWEEN 0 AND 100');
SELECT pg_temp.add_check('feature_flags', 'ff_rollout_range', 'rollout_pct BETWEEN 0 AND 100');
SELECT pg_temp.add_check('trials', 'trial_window', 'ends_at > starts_at AND extended_days >= 0');
-- Break-glass: dual control, max 4 hours.
SELECT pg_temp.add_check('break_glass_requests', 'bg_dual_control',
  'approved_by_id IS NULL OR approved_by_id <> requested_by_id');
SELECT pg_temp.add_check('break_glass_requests', 'bg_duration', 'duration_min BETWEEN 1 AND 240');
-- Pending claims must carry an expiry.
SELECT pg_temp.add_check('domain_claims', 'dc_pending_expiry', 'status <> ''PENDING'' OR pending_expires_at IS NOT NULL');
