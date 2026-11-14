-- =============================================================================
-- 180 — Phase 8: billing and trials. Idempotent (runs on every deploy after 010–170).
--
-- * The billing tables were created in Phase 1 (init migration) and are already tenant-isolated by 020_rls
--   (subscriptions, trials, gateway_customers, payments, invoices, entitlement_overrides, usage_counters carry org_id).
-- * Webhooks are received by the customer API (wim_app, no system context). It learns WHICH organisation a verified
--   gateway event belongs to through billing_resolve_org (SECURITY DEFINER, returns only an id), then does all of
--   the work inside withTenant(org) — RLS stays on for every row it reads or writes.
-- * Entitlement resolution (packages/queue loadOrgContexts) now reads trials.plan_id and subscription_plans when
--   billing is enabled; the narrow worker roles get exactly those columns.
-- =============================================================================

-- ---------------------------------------------------------------- organisation of a verified gateway object
CREATE OR REPLACE FUNCTION public.billing_resolve_org(p_gateway text, p_subscription_id text, p_customer_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT s.org_id FROM subscriptions s
      WHERE p_subscription_id IS NOT NULL AND s.gateway::text = p_gateway AND s.gateway_subscription_id = p_subscription_id LIMIT 1),
    (SELECT c.org_id FROM gateway_customers c
      WHERE p_customer_id IS NOT NULL AND c.gateway::text = p_gateway AND c.gateway_customer_id = p_customer_id LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public.billing_resolve_org(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_resolve_org(text, text, text) TO wim_app;

-- ---------------------------------------------------------------- invoice numbers for gateways that don't number them
-- (Razorpay). Stripe invoices keep Stripe's own number. A sequence can skip a value when a transaction rolls back;
-- see docs/BILLING.md (GST series numbering is open decision B4b).
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1;
GRANT USAGE ON SEQUENCE public.invoice_number_seq TO wim_app, wim_worker;

-- ---------------------------------------------------------------- customer API (wim_app)
-- Webhook events are platform plumbing: the API records and updates them, never deletes them.
REVOKE DELETE ON public.payment_webhook_events FROM wim_app;
-- Payments and invoices are financial records: no deletes from the API (legal retention).
REVOKE DELETE ON public.payments, public.invoices FROM wim_app;
-- Gateway configuration: read-only for the API (it needs the keys for checkout and webhook verification);
-- written only by the admin API. Unchanged from 050, restated so this file documents the billing surface.
REVOKE INSERT, UPDATE, DELETE ON public.payment_gateway_configs FROM wim_app;

-- ---------------------------------------------------------------- narrow worker roles: entitlement resolution only
GRANT SELECT (plan_id) ON public.trials TO wim_browser;
GRANT SELECT (id, key, active) ON public.subscription_plans TO wim_browser;
GRANT SELECT (id, key, active) ON public.subscription_plans TO wim_scanner;

-- ---------------------------------------------------------------- admin API (wim_admin)
-- Plan entitlements are replaced as a set (Super Admin → Plans); prices and plans are never deleted (versions/archive).
GRANT DELETE ON public.plan_entitlements TO wim_admin;
