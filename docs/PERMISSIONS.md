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
| `audit.view` | Org-level | ✓ | ✓ |  |  |
