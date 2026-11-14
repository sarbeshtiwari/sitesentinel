# Browser runner (Phase 4D): apps/browser-runner — one sandboxed Chromium per execution behind a small control API.
# Networks: browser-control + browser-egress ONLY (no data network, no internet). Holds NO secrets: the per-execution
# capability token is minted by worker-browser and arrives with each session request; the gateway URL is this
# container's own configuration (RUNNER_GATEWAY_URL), never the caller's.
# Run with (required for the Chromium sandbox — see SECURITY.md §29):
#   --security-opt seccomp=infra/security/seccomp/chromium.json --security-opt no-new-privileges:true
#   --cap-drop ALL --read-only --tmpfs /tmp:size=512m --tmpfs /dev/shm:size=256m --memory 1g --cpus 1 --pids-limit 512
# Build: docker build -f infra/docker/browser-runner.Dockerfile -t wim-browser-runner .
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wim/browser-runner..." \
 && pnpm --filter "@wim/browser-runner..." run build \
 && pnpm --filter @wim/browser-runner deploy --prod --legacy /out

FROM mcr.microsoft.com/playwright:v1.65.0-noble
ENV NODE_ENV=production HOME=/tmp RUNNER_SANDBOX=true
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /out /app
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
