-- Phase 4H: declared in schema.prisma (was created by sql/150 before; IF NOT EXISTS keeps databases that already have it)
CREATE UNIQUE INDEX IF NOT EXISTS "usage_discrepancies_unique" ON "usage_discrepancies"("run_id", "org_id", "check");
