# Phase 1 — Foundation: summary

## Definition of Done

> A user can sign up/log in, an Owner can create a custom role with specific permissions and team
> scoping, assign it to an invited user, and the backend correctly allows/denies access based on
> that role in at least one real protected resource. Tests cover permission + scope enforcement.

Met. The protected resource is **teams**. The end-to-end test
`apps/api/test/authorization.test.ts › "a team-scoped custom role sees and edits only its team"`
registers an organization, creates a custom role (`teams.view`, `games.view`), invites a user with
that role scoped to one team, accepts the invitation, and asserts: the list shows only that team;
another team's id returns 404; edit, create, delete and export are refused (403); member and role
management are refused. The same flow was also driven through the real web UI in headless
Chromium (Arabic and English).

## Built

**Tenancy and data**

- Multi-tenant schema from the first migration (`organization_id` everywhere), in a dedicated
  `app` schema with RLS on every table, composite tenant foreign keys, append-only audit log.

**Authentication** (Redis server-side sessions)

- Organization signup (creates the tenant and its first Owner), sign-in, sign-out, organization
  switcher, password recovery by email, password change, "sign out other devices".
- Discord OAuth: link from Settings, then sign in with Discord.
- Rate limiting, Origin checks, security events in the audit log.

**Authorization**

- Permission catalog with granular per-action keys; roles as data; default roles (Owner locked,
  Head of Esports, Esports Manager, Esports Operations) editable/removable; custom roles with
  English and Arabic names.
- Team- and department-scoped role assignments, enforced in every query and record check through a
  reusable guard + `scopeCondition()` + `access.coversTeam()`.
- Owner-only permissions that can't be delegated (prevents privilege escalation); multiple Owners;
  last-Owner protection.
- Invitations (7-day, single-use links; optional "make Owner"), member suspension with instant
  session revocation, reactivation.
- Platform-admin tier: separate from tenants, CLI-granted, read-only cross-tenant views that are
  audited on the tenant.

**Resources**: departments, teams (create/edit/delete/CSV export, all scoped), configurable games
(16 seeded titles per organization), organization settings.

**Shared services**: audit log (+ viewer with filters), notification service with
permission-based recipient resolution (+ in-app inbox and unread badge), bilingual mail service.

**Dashboard**: Next.js 16, Arabic/English with full right-to-left layout and saved language
preference, role-aware navigation, sign-in / signup / reset / invitation pages, teams &
departments, games, members & invitations, role editor with permission matrix, audit log,
notifications, settings, platform admin. Responsive down to phone width.

**Engineering**: OpenAPI docs at `/docs` (non-production), generated permission matrix, CI
workflow, Dockerfile, docker-compose for local services, `.env.example` files.

## Test results (run on 16 Oct 2026, in the build workspace)

| Suite                                                                | Result          |
| -------------------------------------------------------------------- | --------------- |
| `packages/shared` (catalog integrity)                                | 6 pass, 0 fail  |
| `apps/api` (integration on real Postgres 16 + Redis 7, plus unit)    | 76 pass, 0 fail |
| `apps/web` (catalog parity + every label resolves in both languages) | 6 pass, 0 fail  |
| ESLint, Prettier, TypeScript (all workspaces)                        | clean           |
| `next build` (production)                                            | succeeds        |

The final verification run's exact numbers are in the delivery message for this phase.

## Not verified here

- **Docker image build**: no Docker daemon in the build workspace. The Dockerfile's steps were
  reproduced by hand in a clean folder and the API booted from that layout in production mode
  (health, auth, migrations OK) — this caught and fixed two real startup bugs — but `docker build`
  itself has not run.
- **CI workflow**: written, not executed (no GitHub repository yet).
- **Real Discord, SMTP, Supabase and Upstash**: no credentials. Discord is tested against a fake
  provider; mail against the dev outbox; Postgres/Redis are local equivalents.

## Deferred or simplified (and why)

- **MFA** → v2 (your decision).
- **Email verification at organization signup** → not in the spec; invited users are verified by
  their link. Worth adding before public SaaS signup.
- **Real-time notifications** → polling every 30 s for now; delivery channels can be added behind
  the existing service.
- **Versioning service** → Phase 3 with contracts, its first consumer.
- **Platform admin write actions** (suspend an organization, impersonation) → not requested;
  read-only for now.
- **Removing a member entirely** (vs suspending) → not requested; suspension covers offboarding.
- **Delegating invitations / role management to non-Owners** → owner-only by design for now
  (see DECISIONS.md, authorization model).

## Needed from you before production

SMTP provider credentials, Supabase project, Redis URL, `SESSION_SECRET`, hosting choice (Railway or
Fly.io), Discord OAuth app (optional), and the product name. Details in `DECISIONS.md` → "Still open".
