# syntax=docker/dockerfile:1.7
# Customer + admin API (NestJS on Fastify). Networks: app (from nginx only) + data + outbound (S3, email/payment APIs).
# Run with: read_only, cap_drop ALL, no-new-privileges, tmpfs /tmp (the admin:create CLI writes its QR code there).
# Multi-arch (linux/arm64 + linux/amd64): every stage uses official multi-arch images; nothing is arch-specific.
# Build: docker buildx build --platform linux/arm64 -f infra/docker/api.Dockerfile -t wim-api .
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=wim-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@wim/api..." \
 && pnpm --filter "@wim/api..." run build \
 && pnpm --filter @wim/api deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4000
ENV HOST=0.0.0.0 PORT=4000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# First super admin: docker compose run --rm api node dist/cli/create-admin.js --email you@example.com --name "You"
CMD ["node", "--enable-source-maps", "dist/main.js"]
