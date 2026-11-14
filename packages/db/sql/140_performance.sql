-- Phase 4G: performance rollups and thresholds. Idempotent.

-- Rollups are written only by the rollup job (wim_worker, system context). Customers read their own rows (RLS).
REVOKE INSERT, UPDATE, DELETE ON public.metrics_hourly, public.metrics_daily FROM wim_app;
GRANT SELECT ON public.metrics_hourly, public.metrics_daily TO wim_app;
-- the watermark is platform state: worker only
REVOKE ALL ON public.rollup_state FROM wim_app, wim_admin, wim_readonly;
GRANT SELECT, INSERT, UPDATE ON public.rollup_state TO wim_worker;

-- A rollup row's subject must belong to its organisation and website (WEBSITE: the website itself; PAGE: one of its
-- monitored pages) — a rollup can never mix tenants.
CREATE OR REPLACE FUNCTION public.rollup_subject_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.subject_type = 'WEBSITE' THEN
    IF NEW.subject_id <> NEW.website_id OR NOT EXISTS (SELECT 1 FROM websites w WHERE w.id = NEW.website_id AND w.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'rollup subject does not match its website and organisation' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.subject_type = 'PAGE' THEN
    IF NOT EXISTS (SELECT 1 FROM monitored_pages m WHERE m.id = NEW.subject_id AND m.website_id = NEW.website_id AND m.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'rollup page does not match its website and organisation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['metrics_hourly', 'metrics_daily'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS rollup_subject_tenant ON public.%I', t);
    EXECUTE format('CREATE TRIGGER rollup_subject_tenant BEFORE INSERT OR UPDATE OF org_id, website_id, subject_type, subject_id ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.rollup_subject_tenant()', t);
  END LOOP;
END $$;
