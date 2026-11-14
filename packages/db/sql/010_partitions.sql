-- =============================================================================
-- 010 — Partition management for high-volume tables.
-- Parents are created PARTITION BY RANGE by the Prisma migration (rewritten by
-- scripts/partition-migration.mjs). Children live in schema `partitions` so
-- Prisma's introspection of `public` never reports them as drift.
-- worker-maintenance calls partitions.ensure_all() hourly and
-- partitions.apply_retention() daily. Idempotent: safe to re-run.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS partitions;

CREATE TABLE IF NOT EXISTS partitions.config (
  parent      text PRIMARY KEY,
  granularity text NOT NULL CHECK (granularity IN ('day', 'month')),
  premake     int  NOT NULL CHECK (premake BETWEEN 1 AND 60),   -- future partitions kept ready
  retain      interval NOT NULL                                 -- drop partitions entirely older than this
);

-- Defaults mirror ARCHITECTURE.md §15. worker-maintenance overwrites `retain`
-- from platform settings, so admins can change retention without SQL.
INSERT INTO partitions.config (parent, granularity, premake, retain) VALUES
  ('monitoring_executions',      'day',   7, interval '62 days'),
  ('check_results',              'day',   7, interval '14 days'),
  ('page_test_results',          'day',   7, interval '14 days'),
  ('component_test_results',     'day',   7, interval '14 days'),
  ('responsive_test_results',    'day',   7, interval '14 days'),
  ('performance_metrics',        'day',   7, interval '14 days'),
  ('api_test_results',           'day',   7, interval '14 days'),
  ('sdk_events',                 'day',   7, interval '7 days'),
  ('metrics_hourly',             'month', 2, interval '62 days'),
  ('metrics_daily',              'month', 2, interval '400 days'),
  ('website_health_scores',      'month', 2, interval '62 days'),
  ('incident_occurrences',       'month', 2, interval '93 days'),
  ('notification_delivery_logs', 'month', 2, interval '93 days'),
  ('login_attempts',             'month', 2, interval '365 days'),
  ('security_events',            'month', 2, interval '730 days'),
  ('system_health_logs',         'month', 2, interval '93 days')
ON CONFLICT (parent) DO NOTHING;

-- Create a single partition covering [p_start, next boundary).
CREATE OR REPLACE FUNCTION partitions.create_one(p_parent text, p_granularity text, p_start date)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_start date := CASE p_granularity WHEN 'month' THEN date_trunc('month', p_start)::date ELSE p_start END;
  v_end   date := CASE p_granularity WHEN 'month' THEN (v_start + interval '1 month')::date ELSE v_start + 1 END;
  v_name  text := p_parent || '_p' || to_char(v_start, CASE p_granularity WHEN 'month' THEN 'YYYYMM' ELSE 'YYYYMMDD' END);
BEGIN
  IF to_regclass('partitions.' || quote_ident(v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE partitions.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
      v_name, p_parent, v_start, v_end);
  END IF;
  RETURN v_name;
END $$;

-- Ensure partitions exist from yesterday (late-arriving writes) through the premake horizon.
CREATE OR REPLACE FUNCTION partitions.ensure_all()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  c record;
  d date;
  n int := 0;
BEGIN
  FOR c IN SELECT * FROM partitions.config LOOP
    IF c.granularity = 'day' THEN
      FOR d IN SELECT generate_series(current_date - 1, current_date + c.premake, interval '1 day')::date LOOP
        PERFORM partitions.create_one(c.parent, 'day', d); n := n + 1;
      END LOOP;
    ELSE
      FOR d IN SELECT generate_series(date_trunc('month', current_date - 1),
                                      date_trunc('month', current_date) + make_interval(months => c.premake),
                                      interval '1 month')::date LOOP
        PERFORM partitions.create_one(c.parent, 'month', d); n := n + 1;
      END LOOP;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Detach and drop partitions whose entire range is older than the retention window.
-- The upper bound is parsed from the partition name (format set by create_one).
CREATE OR REPLACE FUNCTION partitions.apply_retention()
RETURNS TABLE (dropped text) LANGUAGE plpgsql AS $$
DECLARE
  c record;
  p record;
  v_upper date;
  v_suffix text;
BEGIN
  FOR c IN SELECT * FROM partitions.config LOOP
    FOR p IN
      SELECT child.relname
        FROM pg_inherits i
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_class child  ON child.oid  = i.inhrelid
        JOIN pg_namespace ns ON ns.oid = child.relnamespace
       WHERE parent.relname = c.parent AND ns.nspname = 'partitions'
    LOOP
      v_suffix := substring(p.relname from '_p([0-9]+)$');
      CONTINUE WHEN v_suffix IS NULL;
      v_upper := CASE c.granularity
                   WHEN 'day'   THEN to_date(v_suffix, 'YYYYMMDD') + 1
                   ELSE (to_date(v_suffix, 'YYYYMM') + interval '1 month')::date
                 END;
      IF v_upper < (now() - c.retain)::date THEN
        EXECUTE format('ALTER TABLE public.%I DETACH PARTITION partitions.%I', c.parent, p.relname);
        EXECUTE format('DROP TABLE partitions.%I', p.relname);
        dropped := p.relname;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END $$;

SELECT partitions.ensure_all();
