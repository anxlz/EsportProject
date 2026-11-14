# Deploy the web app and NestJS API to Vercel

The root `vercel.json` already defines separate `web` and `api` services, rewrites `/api/*` to
the API service, a daily scheduler cron, and a scheduler daemon. Keep both services in the same
Vercel project/domain so browser requests and session cookies remain first-party.

## Vercel project setup

1. Import the GitHub repository and use the repository root as the project root (not `apps/web`).
   The services in `vercel.json` set their own roots.
2. Select Bun 1.4.x (also set in `vercel.json`). The root `bunfig.toml` hoists dependencies so
   the API function tracer can include workspace modules.
   The root multi-service route sends `/api/*` directly to the API service, so `API_URL` is not
   needed for this deployment. Set `API_URL` on the web service only if deploying it without the
   root API service (for example, the web-only Cloudflare Tunnel setup in the README).
3. Configure the API's Production variables using [vercel-production.env.example](../vercel-production.env.example).
   Values in that file are placeholders, not usable credentials. Set corresponding Preview
   variables separately if Preview deployments need real services.
4. For Supabase, use the **Session pooler** hostname and port 5432. The direct host may require
   IPv6 that a Vercel function does not have. If using the Transaction pooler on port 6543,
   explicitly set `DATABASE_PREPARE=false`. Vercel defaults the Postgres pool to two connections;
   this can be overridden with `DATABASE_POOL_MAX` (1–3 is a sensible serverless range).
   Supabase is optional: if Postgres runs in the AWS/other hosted stack, point the same
   `DATABASE_URL` variable at that database instead.
5. `REDIS_URL` must be a `redis://` or `rediss://` connection string for a TCP-compatible Redis
   service, including providers' TCP endpoint/password. `ioredis` cannot use an HTTPS REST URL.
   The connection is lazy, has a short command/connect timeout, and bounded retries.
6. The app defaults production cookies to `Secure`, `SameSite=Lax`, and the `__Host-esp_sid`
   name. `TRUST_PROXY_HOPS=1` is set for Vercel. The web/API rewrite makes the cookie first-party;
   do not point browser code at the API's direct function hostname.
7. When using `LLM_PROVIDER=local`, the Vercel API must reach the configured model endpoint.
   A laptop's `localhost` is not reachable from Vercel. See [Local LLM deployment](./LOCAL-LLM.md)
   for a secured tunnel or private-host setup.

## Separate web and API projects

For two independent Vercel projects, set the web project's Root Directory to `apps/web` and its
`API_URL` to the API project's HTTPS URL (without a trailing slash). Set the API project's Root
Directory to `apps/api`, and configure its runtime variables there, including `WEB_APP_URL` set
to the web project's production URL. The root multi-service configuration above does not apply
to either subdirectory-rooted project; the web app's Next.js rewrite proxies `/api/*` to `API_URL`.

The API is deployed as Node ESM. Keep `.js` extensions on relative imports in its TypeScript
source (and the shared workspace): TypeScript and Bun resolve those specifiers to `.ts` source,
while the deployed Node runtime needs the extension to resolve compiled JavaScript modules.

## Migrations

Deployments do not run migrations at cold start. From a trusted machine or CI runner with network
access to the production database, run the migration script before deploying a schema-dependent
release:

```powershell
$env:DATABASE_URL = "YOUR_PRODUCTION_SESSION_POOLER_URL"
bun run db:migrate
```

Use the Transaction pooler only with `DATABASE_PREPARE=false`. Never add production credentials
to repository files or build logs. For releases that require a migration, apply it before the
deployment; the migration scripts are designed to be applied once by the project migration
runner, not by each serverless instance.

## Health, auth and registration smoke checks

After deployment, check:

- `https://YOUR_WEB_DOMAIN/api/auth/config` returns the public auth configuration.
- `https://YOUR_WEB_DOMAIN/api/health` returns `status: "ok"` and `database: "up"`,
  `redis: "up"`. The endpoint reports only dependency state, never connection strings or secrets.
- In a private browser window, visit `/register`, create a test organization, and confirm the
  response sets a `Secure`, `SameSite=Lax`, `__Host-esp_sid` cookie. Remove the test data after
  the smoke test.

Vercel limits function request bodies to 4.5 MB. The API therefore caps JSON and direct file
uploads at 4 MB on Vercel, leaving transport overhead; local/container deployments retain their
existing larger parser limit. Upload kinds still have their own smaller application-level limits.

## Scheduler

The configured cron calls `/api/internal/scheduler/tick` daily. Vercel Hobby cron schedules are
limited to daily execution; the existing scheduler daemon performs regular work between cron
invocations. `CRON_SECRET` must be configured so Vercel's authorization header is checked. Do not
remove the daemon or daily cron unless scheduling is intentionally moved to another always-on
worker.

## Redeploy and logs

- Push a commit to the connected branch for an automatic deployment, or use **Deployments →
  Redeploy** in the Vercel project.
- For manual deployments, use the Vercel CLI from the repository root (`vercel` for Preview,
  `vercel --prod` for Production) after linking the project.
- In **Vercel → Project → Deployments → select deployment → Functions → `src/main.ts` → Logs**,
  inspect invocation logs for Nest startup, database/Redis errors, timeouts, and request failures.
  Never paste environment values or secrets into support tickets or logs.

The API entrypoint caches its initialized Nest application between warm invocations and does not
call `listen()` on Vercel. It still uses `listen()` for local/container deployments.
