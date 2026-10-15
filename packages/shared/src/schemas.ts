/**
 * Request validation schemas shared by the API (enforcement) and the web app (form validation).
 * The API is the authority: the web app uses these only to give earlier feedback.
 */
import { z } from 'zod';
import { GRANTABLE_PERMISSION_KEYS, type PermissionKey } from './permissions';

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

/** NIST 800-63B style: length over composition rules. */
export const passwordSchema = z.string().min(10).max(128);

export const uuidSchema = z.uuid();

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug_format');

// ---------- Auth ----------

export const registerOrganizationSchema = z.object({
  organizationName: trimmed(2, 120),
  organizationSlug: slugSchema,
  defaultLocale: localeSchema,
  displayName: trimmed(1, 120),
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterOrganizationInput = z.infer<typeof registerOrganizationSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // No length policy on login: never reveal policy details through login errors.
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const switchOrganizationSchema = z.object({ organizationId: uuidSchema });

export const updateProfileSchema = z
  .object({
    displayName: trimmed(1, 120).optional(),
    locale: localeSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');

// ---------- Role assignments ----------

export const scopeTypeSchema = z.enum(['organization', 'department', 'team']);

export const roleAssignmentInputSchema = z
  .object({
    roleId: uuidSchema,
    scopeType: scopeTypeSchema,
    /** Department or team id. Must be null/absent when scopeType is 'organization'. */
    scopeId: uuidSchema.nullable().optional(),
  })
  .refine(
    (a) => (a.scopeType === 'organization' ? !a.scopeId : !!a.scopeId),
    'scope_id_mismatch',
  );
export type RoleAssignmentInput = z.infer<typeof roleAssignmentInputSchema>;

export const setAssignmentsSchema = z.object({
  assignments: z.array(roleAssignmentInputSchema).max(50),
});

// ---------- Roles ----------

const grantableKeys = GRANTABLE_PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]];

export const roleInputSchema = z
  .object({
    nameEn: trimmed(1, 80).nullable().optional(),
    nameAr: trimmed(1, 80).nullable().optional(),
    descriptionEn: z.string().trim().max(500).nullable().optional(),
    descriptionAr: z.string().trim().max(500).nullable().optional(),
    // Owner-only keys are rejected here AND re-checked in the service layer.
    permissions: z.array(z.enum(grantableKeys)).max(200),
  })
  .refine((r) => !!(r.nameEn || r.nameAr), 'role_name_required');
export type RoleInput = z.infer<typeof roleInputSchema>;

// ---------- Members ----------

export const suspendMemberSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  assignments: z.array(roleAssignmentInputSchema).max(50),
  makeOwner: z.boolean().optional(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  displayName: trimmed(1, 120),
  password: passwordSchema,
});

// ---------- Organization ----------

export const updateOrganizationSchema = z
  .object({
    name: trimmed(2, 120).optional(),
    defaultLocale: localeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');

// ---------- Departments / Teams / Games ----------

export const departmentInputSchema = z.object({
  name: trimmed(1, 120),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const teamStatusSchema = z.enum(['active', 'inactive']);

export const teamCreateSchema = z.object({
  name: trimmed(1, 120),
  departmentId: uuidSchema.nullable().optional(),
  gameId: uuidSchema.nullable().optional(),
  region: z.string().trim().max(80).nullable().optional(),
  status: teamStatusSchema.default('active'),
});
export type TeamCreateInput = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z
  .object({
    name: trimmed(1, 120).optional(),
    departmentId: uuidSchema.nullable().optional(),
    gameId: uuidSchema.nullable().optional(),
    region: z.string().trim().max(80).nullable().optional(),
    status: teamStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');

export const gameInputSchema = z.object({
  name: trimmed(1, 120),
  shortName: z.string().trim().max(20).nullable().optional(),
  isActive: z.boolean().default(true),
});

export const gameUpdateSchema = z
  .object({
    name: trimmed(1, 120).optional(),
    shortName: z.string().trim().max(20).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty_update');

// ---------- Queries ----------

export const auditLogQuerySchema = z.object({
  action: z.string().max(100).optional(),
  actorUserId: uuidSchema.optional(),
  targetType: z.string().max(50).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const notificationsQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
