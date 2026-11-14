# Staging isolation probe image (release readiness, blocker 2). NOT deployed as a workload: it is attached to a running
# pod as an EPHEMERAL debug container (`kubectl debug --target=…`), so the probes run inside that pod's network namespace
# and test exactly the policies applied to it. Contains the repository build at /repo (the probe script's expectation).
# Build: docker build -f infra/staging/probe.Dockerfile -t REGISTRY/wim-isolation-probe:<tag> .
FROM mcr.microsoft.com/playwright:v1.65.0-noble
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter "@wim/netguard..." --filter "@wim/worker-deepscan..." run build
USER pwuser
ENTRYPOINT ["node", "infra/security/isolation/probe.mjs"]
