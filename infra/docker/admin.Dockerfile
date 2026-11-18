# syntax=docker/dockerfile:1.7
# Super Admin app (Next.js) — self-contained `output: "standalone"` server (NEXT_OUTPUT_STANDALONE=1, see apps/admin/next.config.ts).
# API_INTERNAL_URL is baked in at BUILD time (Next rewrites are compiled into the routes manifest; turbo.json lists it):
# in the Oracle stack nginx sends /api/* straight to the API, the rewrite is only a fallback for direct access.
# ADMIN_URL is read at runtime (metadata base URL) and passed at build time too so statically rendered pages agree.
# Networks: app only (no data, no internet). Run with: read_only, cap_drop ALL, no-new-privileges, tmpfs .next/cache.
# Build: docker buildx build --platform linux/arm64 -f infra/docker/admin.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t wim-admin .
FROM node:24-bookworm-slim AS build
ARG API_INTERNAL_URL=http://api:4000
ARG ADMIN_URL
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT_STANDALONE=1 \
    API_INTERNAL_URL=${API_INTERNAL_URL} ADMIN_URL=${ADMIN_URL}
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/admin..." \
 && pnpm --filter "@wim/admin..." run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /src/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build --chown=node:node /src/apps/admin/public ./apps/admin/public
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "apps/admin/server.js"]
