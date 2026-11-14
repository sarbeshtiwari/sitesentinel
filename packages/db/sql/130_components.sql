-- Phase 4F (approved scope): component detection, safe functional tests, responsive matrix. Idempotent.

-- ---------------------------------------------------------------- one logical result per execution
-- Functional test results are browser (T2_RENDER) results: they need the execution's ledger row, like page results.
DROP TRIGGER IF EXISTS result_requires_ledger ON public.component_test_results;
CREATE TRIGGER result_requires_ledger BEFORE INSERT OR UPDATE OF execution_id ON public.component_test_results
  FOR EACH ROW EXECUTE FUNCTION public.result_requires_ledger('component_test_results');

-- ---------------------------------------------------------------- tenancy of the component inventory
CREATE OR REPLACE FUNCTION public.page_component_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'page_components' THEN
    IF NOT EXISTS (SELECT 1 FROM monitored_pages m WHERE m.id = NEW.monitored_page_id AND m.org_id = NEW.org_id AND m.website_id = NEW.website_id) THEN
      RAISE EXCEPTION 'component does not match its monitored page''s organisation and website' USING ERRCODE = 'check_violation';
    END IF;
  ELSE -- component_events
    IF NOT EXISTS (SELECT 1 FROM page_components c WHERE c.id = NEW.page_component_id AND c.org_id = NEW.org_id AND c.website_id = NEW.website_id) THEN
      RAISE EXCEPTION 'component event does not match its component''s organisation and website' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS page_component_tenant ON public.page_components;
CREATE TRIGGER page_component_tenant BEFORE INSERT OR UPDATE OF org_id, website_id, monitored_page_id ON public.page_components
  FOR EACH ROW EXECUTE FUNCTION public.page_component_tenant();
DROP TRIGGER IF EXISTS component_event_tenant ON public.component_events;
CREATE TRIGGER component_event_tenant BEFORE INSERT OR UPDATE ON public.component_events
  FOR EACH ROW EXECUTE FUNCTION public.page_component_tenant();

-- monitored_pages must belong to the same organisation and website as their discovered page
CREATE OR REPLACE FUNCTION public.monitored_page_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM discovered_pages d WHERE d.id = NEW.discovered_page_id AND d.org_id = NEW.org_id AND d.website_id = NEW.website_id) THEN
    RAISE EXCEPTION 'monitored page does not match its discovered page''s organisation and website' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS monitored_page_tenant ON public.monitored_pages;
CREATE TRIGGER monitored_page_tenant BEFORE INSERT OR UPDATE OF org_id, website_id, discovered_page_id ON public.monitored_pages
  FOR EACH ROW EXECUTE FUNCTION public.monitored_page_tenant();

-- ---------------------------------------------------------------- roles
-- Detection and test results are written only by the browser worker. The customer role reads (RLS) and writes none of
-- them (Phase 1 defaults granted writes; no customer feature uses them — pinning pages and custom test cases are not
-- built yet and will get their own narrow functions when they are).
REVOKE INSERT, UPDATE, DELETE ON public.page_components, public.component_events, public.component_test_results,
                                 public.monitored_pages, public.test_cases FROM wim_app;
GRANT SELECT ON public.page_components, public.component_events, public.component_test_results, public.monitored_pages, public.test_cases TO wim_app;
GRANT SELECT, INSERT, UPDATE ON public.component_events TO wim_worker, wim_browser;
GRANT USAGE, SELECT ON SEQUENCE public.component_events_id_seq TO wim_worker, wim_browser;
GRANT SELECT, INSERT, UPDATE ON public.monitored_pages TO wim_browser;
GRANT SELECT, INSERT, UPDATE ON public.page_components TO wim_browser;
GRANT SELECT ON public.component_test_results TO wim_browser;
-- the admin role never sees components, tests or their history (customer content)
REVOKE ALL ON public.page_components, public.component_events, public.component_test_results FROM wim_admin;
