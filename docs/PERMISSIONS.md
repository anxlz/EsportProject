# Permission matrix

> Generated from `packages/shared/src/permissions.ts` by `bun run docs:permissions`. Do not edit by hand.

Default roles are seeded into every new organization. All of them except **Owner** are fully
editable and deletable by Owners, and Owners can create any number of custom roles.

- **Scopable** permissions are narrowed by the team/department scope of the role assignment.
- **Org-level** permissions apply organization-wide whenever the role is held, whatever the
  assignment scope.
- **Owner-only** permissions cannot be added to custom roles; only the Owner role holds them.

| Permission | Type | Owner | Head of Esports | Esports Manager | Esports Operations |
|---|---|:-:|:-:|:-:|:-:|
| `org.settings.view` | Org-level | ✓ | ✓ |  |  |
| `org.settings.edit` | Org-level | ✓ |  |  |  |
| `org.settings.edit_sensitive` | Owner-only | ✓ |  |  |  |
| `org.ownership.manage` | Owner-only | ✓ |  |  |  |
| `members.view` | Org-level | ✓ | ✓ | ✓ |  |
| `members.invite` | Owner-only | ✓ |  |  |  |
| `members.manage` | Owner-only | ✓ |  |  |  |
| `roles.view` | Org-level | ✓ | ✓ |  |  |
| `roles.manage` | Owner-only | ✓ |  |  |  |
| `departments.view` | Org-level | ✓ | ✓ | ✓ | ✓ |
| `departments.create` | Org-level | ✓ | ✓ |  |  |
| `departments.edit` | Org-level | ✓ | ✓ |  |  |
| `departments.delete` | Org-level | ✓ | ✓ |  |  |
| `teams.view` | Scopable | ✓ | ✓ | ✓ | ✓ |
| `teams.create` | Scopable | ✓ | ✓ |  |  |
| `teams.edit` | Scopable | ✓ | ✓ | ✓ |  |
| `teams.delete` | Scopable | ✓ | ✓ |  |  |
| `teams.export` | Scopable | ✓ | ✓ | ✓ |  |
| `games.view` | Org-level | ✓ | ✓ | ✓ | ✓ |
| `games.manage` | Org-level | ✓ | ✓ |  |  |
| `rosters.view` | Scopable | ✓ | ✓ | ✓ | ✓ |
| `rosters.create` | Scopable | ✓ | ✓ | ✓ |  |
| `rosters.edit` | Scopable | ✓ | ✓ | ✓ |  |
| `rosters.delete` | Scopable | ✓ | ✓ |  |  |
| `rosters.export` | Scopable | ✓ | ✓ | ✓ |  |
| `tournaments.view` | Org-level | ✓ | ✓ | ✓ | ✓ |
| `tournaments.create` | Org-level | ✓ | ✓ |  |  |
| `tournaments.edit` | Org-level | ✓ | ✓ |  |  |
| `tournaments.delete` | Org-level | ✓ | ✓ |  |  |
| `finance.view` | Scopable | ✓ | ✓ | ✓ |  |
| `finance.create` | Scopable | ✓ | ✓ | ✓ |  |
| `finance.edit` | Scopable | ✓ | ✓ |  |  |
| `finance.delete` | Scopable | ✓ | ✓ |  |  |
| `finance.export` | Scopable | ✓ | ✓ | ✓ |  |
| `budgets.manage` | Scopable | ✓ | ✓ |  |  |
| `finance.configure` | Org-level | ✓ |  |  |  |
| `contracts.view` | Scopable | ✓ | ✓ | ✓ |  |
| `contracts.create` | Scopable | ✓ | ✓ | ✓ |  |
| `contracts.edit` | Scopable | ✓ | ✓ | ✓ |  |
| `contracts.export` | Scopable | ✓ | ✓ | ✓ |  |
| `contracts.approve` | Scopable | ✓ |  |  |  |
| `contracts.manage_templates` | Owner-only | ✓ |  |  |  |
| `contracts.send_for_signature` | Scopable | ✓ | ✓ | ✓ |  |
| `audit.view` | Org-level | ✓ | ✓ |  |  |
