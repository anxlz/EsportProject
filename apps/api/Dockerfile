# API image (NestJS on Bun). Build from the REPOSITORY ROOT so the workspace is available:
#   docker build -f apps/api/Dockerfile -t esports-api .
# Portable across Railway, Fly.io and AWS (ECS/App Runner): plain container, no host-specific hooks.
# Run migrations as a release / pre-deploy step:  bun src/db/migrate.ts   (working dir apps/api)
#
# Single stage on purpose: Bun's workspace install links packages with relative symlinks, so
# dependencies must be installed in the same directory layout the app runs from.

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production

# 1. Dependencies (cached layer): manifests only, API workspace + its shared package.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --production --filter '@esports/api'

# 2. Source (node_modules are excluded by .dockerignore, so installed links stay intact).
COPY packages/shared ./packages/shared
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/src ./apps/api/src
COPY apps/api/drizzle ./apps/api/drizzle

# 3. Chromium for PDF report exports (fonts are embedded by the app, so none are installed).
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Bun reads tsconfig.json from the working directory; the API's tsconfig enables the legacy
# decorators (+ metadata) NestJS needs, so the process MUST start from apps/api.
WORKDIR /app/apps/api
USER bun
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/main.ts"]
