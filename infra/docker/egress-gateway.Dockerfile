# Egress gateway: the only internet-facing process on the monitoring path (SECURITY.md §25).
# Build: docker build -f infra/docker/egress-gateway.Dockerfile -t wim-egress-gateway .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wim/egress-gateway..." \
 && pnpm --filter "@wim/egress-gateway..." run build \
 && pnpm --filter @wim/egress-gateway deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
# Run with: read_only, cap_drop ALL, no-new-privileges; networks: outbound + *-egress (internal) only.
CMD ["node", "--enable-source-maps", "dist/main.js"]
