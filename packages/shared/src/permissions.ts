/**
 * Permission catalog — the single source of truth for every permission key in the platform.
 *
 * Rules (see DECISIONS.md "Authorization model"):
 * - Backend code checks permission KEYS, never role names.
 * - `scopable: true` means a role assignment's team/department scope narrows which records the
 *   permission covers. `scopable: false` permissions are organization-level: they apply as-is
 *   whenever the role is assigned, regardless of the assignment's scope.
 * - `ownerOnly: true` permissions can never be granted to a custom role. Only roles flagged
 *   `grantsAll` (the locked Owner system role) hold them. This prevents privilege escalation,
 *   e.g. a non-owner who can edit roles granting themselves everything.
 *
 * The catalog grows phase by phase: a key is only added once the resource it protects exists,
 * so the role editor never shows toggles that do nothing.
 */

export const PERMISSION_DOMAINS = [
  'organization',
  'members',
  'roles',
  'departments',
  'teams',
  'games',
  'rosters',
  'tournaments',
  'finance',
  'contracts',
  'assistants',
  'meetings',
  'integrations',
  'audit',
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export interface PermissionDefinition {
  domain: PermissionDomain;
  scopable: boolean;
  ownerOnly: boolean;
}

const def = (
  domain: PermissionDomain,
  opts: { scopable?: boolean; ownerOnly?: boolean } = {},
): PermissionDefinition => ({
  domain,
  scopable: opts.scopable ?? false,
  ownerOnly: opts.ownerOnly ?? false,
});

export const PERMISSIONS = {
  // Organization settings
  'org.settings.view': def('organization'),
  'org.settings.edit': def('organization'),
  /** Approval stamp, legal and tax information (fields arrive in Phase 3). */
  'org.settings.edit_sensitive': def('organization', { ownerOnly: true }),
  /** Designate or remove Owners. */
  'org.ownership.manage': def('organization', { ownerOnly: true }),

  // Members
  'members.view': def('members'),
  'members.invite': def('members', { ownerOnly: true }),
  /** Change a member's role assignments, suspend and reactivate members. */
  'members.manage': def('members', { ownerOnly: true }),

  // Roles
  'roles.view': def('roles'),
  'roles.manage': def('roles', { ownerOnly: true }),

  // Departments (organization structure, not scopable)
  'departments.view': def('departments'),
  'departments.create': def('departments'),
  'departments.edit': def('departments'),
  'departments.delete': def('departments'),

  // Teams (scopable by team or department)
  'teams.view': def('teams', { scopable: true }),
  'teams.create': def('teams', { scopable: true }),
  'teams.edit': def('teams', { scopable: true }),
  'teams.delete': def('teams', { scopable: true }),
  'teams.export': def('teams', { scopable: true }),

  // Games (configurable entity)
  'games.view': def('games'),
  'games.manage': def('games'),

  // Rosters — players, coaches and staff on a team (scopable). Pay terms are additionally gated
  // by finance.view on the same team.
  'rosters.view': def('rosters', { scopable: true }),
  'rosters.create': def('rosters', { scopable: true }),
  'rosters.edit': def('rosters', { scopable: true }),
  'rosters.delete': def('rosters', { scopable: true }),
  'rosters.export': def('rosters', { scopable: true }),

  // Tournament research (manual entry, organization-level)
  'tournaments.view': def('tournaments'),
  'tournaments.create': def('tournaments'),
  'tournaments.edit': def('tournaments'),
  'tournaments.delete': def('tournaments'),

  // Finance — expenses, revenue, reports (scopable by team; organization-wide records and
  // organization/tournament/season reports need an organization-wide grant).
  'finance.view': def('finance', { scopable: true }),
  'finance.create': def('finance', { scopable: true }),
  'finance.edit': def('finance', { scopable: true }),
  'finance.delete': def('finance', { scopable: true }),
  'finance.export': def('finance', { scopable: true }),
  /** Create and change budgets for the teams in scope. */
  'budgets.manage': def('finance', { scopable: true }),
  /** Reporting currency, enabled currencies, seasons, exchange-rate refresh. */
  'finance.configure': def('finance'),

  // Contracts (Phase 3). Scopable by the contract's team; contracts without a team need an
  // organization-wide grant. Approval is a separate, delegatable permission. Template-level
  // editing (contract types, their clause lists, the document layout) is Owner-only (spec §7.3).
  'contracts.view': def('contracts', { scopable: true }),
  'contracts.create': def('contracts', { scopable: true }),
  /** Edit drafts, choose optional clauses, submit for approval, withdraw, cancel. */
  'contracts.edit': def('contracts', { scopable: true }),
  'contracts.export': def('contracts', { scopable: true }),
  /** Approve or reject approval requests. Owners hold it; delegate it by adding it to a role. */
  'contracts.approve': def('contracts', { scopable: true }),
  'contracts.manage_templates': def('contracts', { ownerOnly: true }),
  /** Phase 4: start signing an approved contract, create/revoke signing links, cancel signing. */
  'contracts.send_for_signature': def('contracts', { scopable: true }),
  /**
   * ID-document patch: view the identity document a recipient uploaded while signing. Seeing or
   * exporting the contract does NOT include it. Owners hold it; anyone else only by an explicit
   * grant (it is in no default template). Every view is audited.
   */
  'contracts.view_signer_id': def('contracts', { scopable: true }),

  // Audit log
  'audit.view': def('audit'),

  // AI assistants (Phase 5) — access per assistant (spec §4.2). Not scopable: an assistant only
  // ever sees what the invoking user's other permissions let them see.
  'assistants.general': def('assistants'),
  'assistants.formal_message': def('assistants'),
  'assistants.email': def('assistants'),
  'assistants.offer_optimizer': def('assistants'),
  'assistants.player_analyst': def('assistants'),
  /** Send an Email Assistant proposal from the platform, after reviewing it. */
  'assistants.send_email': def('assistants'),

  // Meetings (Phase 6). Scopable by the meeting's team or department; meetings with neither need
  // an organization-wide grant. No approval: a manager who may create a meeting creates it and
  // invites people, who confirm or decline. Everyone always sees the meetings they're invited to.
  'meetings.view': def('meetings', { scopable: true }),
  'meetings.create': def('meetings', { scopable: true }),
  /** Change or cancel any meeting in scope (organizers can always change their own). */
  'meetings.manage': def('meetings', { scopable: true }),
  /** Organization-wide administrative meetings (spec §14: the Owner calls them). */
  'meetings.administrative': def('meetings', { ownerOnly: true }),

  // Integrations (Phase 6): organization-level connections — Notion, outgoing and incoming
  // webhooks. Members connect their own Google Calendar or Obsidian vault without it.
  'integrations.manage': def('integrations'),
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function getPermission(key: PermissionKey): PermissionDefinition {
  return PERMISSIONS[key];
}

/** Permissions that may appear on a custom (non-Owner) role. */
export const GRANTABLE_PERMISSION_KEYS = PERMISSION_KEYS.filter((k) => !PERMISSIONS[k].ownerOnly);

export type ScopeType = 'organization' | 'department' | 'team';

/**
 * Default role templates seeded into every new organization. Names are data (editable); the
 * `templateKey` only records where a role came from. Nothing in the backend branches on it.
 */
export interface DefaultRoleTemplate {
  templateKey: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  grantsAll: boolean;
  permissions: PermissionKey[];
}

export const DEFAULT_ROLE_TEMPLATES: DefaultRoleTemplate[] = [
  {
    templateKey: 'owner',
    nameEn: 'Owner',
    nameAr: 'المالك',
    descriptionEn: 'Full control of the organization. Cannot be edited or deleted.',
    descriptionAr: 'تحكم كامل في المنظمة. لا يمكن تعديله أو حذفه.',
    grantsAll: true,
    permissions: [],
  },
  {
    templateKey: 'head_of_esports',
    nameEn: 'Head of Esports',
    nameAr: 'رئيس الرياضات الإلكترونية',
    descriptionEn: 'Oversees all esports departments, teams and games.',
    descriptionAr: 'يشرف على جميع أقسام وفرق وألعاب الرياضات الإلكترونية.',
    grantsAll: false,
    permissions: [
      'org.settings.view',
      'members.view',
      'roles.view',
      'departments.view',
      'departments.create',
      'departments.edit',
      'departments.delete',
      'teams.view',
      'teams.create',
      'teams.edit',
      'teams.delete',
      'teams.export',
      'games.view',
      'games.manage',
      'audit.view',
      'rosters.view',
      'rosters.create',
      'rosters.edit',
      'rosters.delete',
      'rosters.export',
      'tournaments.view',
      'tournaments.create',
      'tournaments.edit',
      'tournaments.delete',
      'finance.view',
      'finance.create',
      'finance.edit',
      'finance.delete',
      'finance.export',
      'budgets.manage',
      'contracts.view',
      'contracts.create',
      'contracts.edit',
      'contracts.export',
      'contracts.send_for_signature',
      'assistants.general',
      'assistants.formal_message',
      'assistants.email',
      'assistants.offer_optimizer',
      'assistants.player_analyst',
      'assistants.send_email',
      'meetings.view',
      'meetings.create',
      'meetings.manage',
    ],
  },
  {
    templateKey: 'esports_manager',
    nameEn: 'Esports Manager',
    nameAr: 'مدير الرياضات الإلكترونية',
    descriptionEn: 'Manages the teams assigned to them.',
    descriptionAr: 'يدير الفرق المسندة إليه.',
    grantsAll: false,
    permissions: [
      'members.view',
      'departments.view',
      'teams.view',
      'teams.edit',
      'teams.export',
      'games.view',
      'rosters.view',
      'rosters.create',
      'rosters.edit',
      'rosters.export',
      'tournaments.view',
      'finance.view',
      'finance.create',
      'finance.export',
      'contracts.view',
      'contracts.create',
      'contracts.edit',
      'contracts.export',
      'contracts.send_for_signature',
      'assistants.general',
      'assistants.formal_message',
      'assistants.email',
      'assistants.offer_optimizer',
      'assistants.player_analyst',
      'assistants.send_email',
      'meetings.view',
      'meetings.create',
      'meetings.manage',
    ],
  },
  {
    templateKey: 'esports_operations',
    nameEn: 'Esports Operations',
    nameAr: 'عمليات الرياضات الإلكترونية',
    descriptionEn: 'Day-to-day operational view of teams.',
    descriptionAr: 'عرض تشغيلي يومي للفرق.',
    grantsAll: false,
    permissions: [
      'departments.view',
      'teams.view',
      'games.view',
      'rosters.view',
      'tournaments.view',
      'assistants.general',
      'assistants.formal_message',
      'assistants.email',
      'meetings.view',
    ],
  },
];

/** Games seeded into every new organization. Fully editable afterwards. */
export const DEFAULT_GAMES: { name: string; shortName: string }[] = [
  { name: 'VALORANT', shortName: 'VAL' },
  { name: 'Counter-Strike 2', shortName: 'CS2' },
  { name: 'League of Legends', shortName: 'LoL' },
  { name: 'Dota 2', shortName: 'Dota 2' },
  { name: 'Rocket League', shortName: 'RL' },
  { name: 'EA SPORTS FC', shortName: 'FC' },
  { name: 'PUBG Mobile', shortName: 'PUBGM' },
  { name: 'Fortnite', shortName: 'FN' },
  { name: 'Call of Duty', shortName: 'CoD' },
  { name: 'Overwatch 2', shortName: 'OW2' },
  { name: 'Apex Legends', shortName: 'Apex' },
  { name: 'Rainbow Six Siege', shortName: 'R6' },
  { name: 'Street Fighter 6', shortName: 'SF6' },
  { name: 'Tekken 8', shortName: 'T8' },
  { name: 'Free Fire', shortName: 'FF' },
  { name: 'Mobile Legends: Bang Bang', shortName: 'MLBB' },
];
