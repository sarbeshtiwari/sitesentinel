-- =============================================================================
-- 100 — Phase 4D: one-result-per-execution ledger, browser results, artifacts. Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------- one logical result per execution
-- execution_results is NOT partitioned, so execution_id alone is unique. Every result row must point at a
-- ledger row of its tier whose window_start equals the row's partition timestamp; together with the per-table
-- unique (execution_id, …, timestamp) indexes this makes a second logical result for an execution impossible,
-- whatever timestamp a buggy or malicious writer chooses.
CREATE OR REPLACE FUNCTION public.result_requires_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ts timestamptz; ok boolean; parent text := TG_ARGV[0]; -- TG_TABLE_NAME is the partition, not the parent
BEGIN
  -- (field access via jsonb: each table names its partition timestamp differently)
  ts := (to_jsonb(NEW) ->> CASE parent WHEN 'check_results' THEN 'checked_at'
                                              WHEN 'performance_metrics' THEN 'measured_at' ELSE 'tested_at' END)::timestamptz;
  IF NEW.execution_id IS NULL THEN
    IF parent = 'performance_metrics' THEN RETURN NEW; END IF; -- RUM rows (SDK) have no execution
    RAISE EXCEPTION 'result without execution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT true INTO ok FROM execution_results
   WHERE execution_id = NEW.execution_id AND window_start = ts AND org_id = NEW.org_id AND website_id = NEW.website_id
     AND tier = CASE parent WHEN 'check_results' THEN 'T1_HTTP'::"CheckTier" ELSE 'T2_RENDER'::"CheckTier" END;
  IF ok IS NULL THEN
    RAISE EXCEPTION 'result for execution % has no matching execution_results ledger row', NEW.execution_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['check_results', 'page_test_results', 'performance_metrics', 'responsive_test_results'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS result_requires_ledger ON public.%I', t);
    EXECUTE format('CREATE TRIGGER result_requires_ledger BEFORE INSERT OR UPDATE OF execution_id ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.result_requires_ledger(%L)', t, t);
  END LOOP;
END $$;

-- Ledger rows are never rewritten by workers (only retention deletes them).
REVOKE UPDATE ON public.execution_results FROM wim_worker;

-- ---------------------------------------------------------------- retention (≈60 days, like executions)
UPDATE partitions.config SET retain = interval '62 days'
 WHERE parent IN ('page_test_results', 'performance_metrics', 'responsive_test_results') AND retain < interval '62 days';
SELECT partitions.ensure_all();

-- ---------------------------------------------------------------- customer role: read own rows only (RLS)
REVOKE INSERT, UPDATE, DELETE ON public.execution_results, public.page_test_results, public.performance_metrics,
  public.responsive_test_results, public.artifacts FROM wim_app;
-- The Phase 1 browser role is not used by the 4D design (the browser has no database access at all).

-- ---------------------------------------------------------------- Super Admin aggregate (no org, website, URL, artifact)
CREATE OR REPLACE VIEW public.admin_v_browser_check_health AS
SELECT count(*) FILTER (WHERE r.recorded_at > now() - interval '1 hour')                                         AS executions_1h,
       count(*) FILTER (WHERE r.recorded_at > now() - interval '1 hour' AND r.outcome = 'PASSED')                AS passed_1h,
       count(*) FILTER (WHERE r.recorded_at > now() - interval '1 hour' AND r.outcome = 'FAILED')                AS failed_1h,
       count(*) FILTER (WHERE r.recorded_at > now() - interval '1 hour' AND r.outcome = 'INCONCLUSIVE')          AS inconclusive_1h,
       max(r.recorded_at) FILTER (WHERE r.outcome <> 'INCONCLUSIVE')                                             AS last_completed_at,
       (SELECT count(*) FROM page_test_results p WHERE p.tested_at > now() - interval '24 hours'
           AND p.failure_category IN ('BROWSER_INFRASTRUCTURE', 'GATEWAY_INFRASTRUCTURE'))                       AS infra_failures_24h,
       (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (p.details #>> '{durationMs}')::int) FROM page_test_results p
         WHERE p.tested_at > now() - interval '1 hour' AND p.details ? 'durationMs')                             AS p95_viewport_ms_1h,
       (SELECT coalesce(sum(a.bytes), 0) FROM artifacts a WHERE a.created_at > now() - interval '24 hours')      AS artifact_bytes_24h
  FROM execution_results r
 WHERE r.tier = 'T2_RENDER' AND r.recorded_at > now() - interval '24 hours';

GRANT SELECT ON public.admin_v_browser_check_health TO wim_admin, wim_readonly;
