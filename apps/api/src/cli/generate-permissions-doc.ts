/**
 * Generates docs/PERMISSIONS.md from the actual permission catalog and default role templates,
 * so the documentation can never drift from the implementation (a test checks it is current).
 *
 *   bun run docs:permissions
 */
import {
  DEFAULT_ROLE_TEMPLATES,
  PERMISSION_DOMAINS,
  PERMISSION_KEYS,
  PERMISSIONS,
} from '@esports/shared';
import { fileURLToPath } from 'node:url';

export const PERMISSIONS_DOC_PATH = fileURLToPath(
  new URL('../../../../docs/PERMISSIONS.md', import.meta.url),
);

export function renderPermissionsDoc(): string {
  const roles = DEFAULT_ROLE_TEMPLATES;
  const lines: string[] = [
    '# Permission matrix',
    '',
    '> Generated from `packages/shared/src/permissions.ts` by `bun run docs:permissions`. Do not edit by hand.',
    '',
    'Default roles are seeded into every new organization. All of them except **Owner** are fully',
    'editable and deletable by Owners, and Owners can create any number of custom roles.',
    '',
    '- **Scopable** permissions are narrowed by the team/department scope of the role assignment.',
    '- **Org-level** permissions apply organization-wide whenever the role is held, whatever the',
    '  assignment scope.',
    '- **Owner-only** permissions cannot be added to custom roles; only the Owner role holds them.',
    '',
    `| Permission | Type | ${roles.map((r) => r.nameEn).join(' | ')} |`,
    `|---|---|${roles.map(() => ':-:').join('|')}|`,
  ];
  for (const domain of PERMISSION_DOMAINS) {
    for (const key of PERMISSION_KEYS.filter((k) => PERMISSIONS[k].domain === domain)) {
      const def = PERMISSIONS[key];
      const type = def.ownerOnly ? 'Owner-only' : def.scopable ? 'Scopable' : 'Org-level';
      const cells = roles.map((r) => (r.grantsAll || r.permissions.includes(key) ? '✓' : ''));
      lines.push(`| \`${key}\` | ${type} | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

if (import.meta.main) {
  await Bun.write(PERMISSIONS_DOC_PATH, renderPermissionsDoc());
  console.log(`Wrote ${PERMISSIONS_DOC_PATH}`);
}
