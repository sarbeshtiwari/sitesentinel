import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations run as the schema owner; runtime services use DATABASE_URL (wim_app/wim_worker).
    // `prisma generate` needs no database, so a missing URL only fails commands that connect.
    url: process.env.MIGRATION_DATABASE_URL ?? "postgresql://unset@localhost/unset",
  },
});
