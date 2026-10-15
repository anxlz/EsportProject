import { Inject, Injectable } from '@nestjs/common';
import { type PermissionKey, PERMISSIONS, type RoleDto, type RoleInput } from '@esports/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AccessService } from '../authz/access.service';
import type { TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { AppError, Errors } from '../common/errors';
import { DB, type Database } from '../db/client';
import { invitations, rolePermissions, roles, userRoleAssignments } from '../db/schema';

@Injectable()
export class RolesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string): Promise<RoleDto[]> {
    const rows = await this.db
      .select()
      .from(roles)
      .where(eq(roles.organizationId, organizationId))
      .orderBy(
        sql`${roles.isSystem} desc`,
        asc(roles.createdAt),
        sql`coalesce(${roles.nameEn}, ${roles.nameAr})`,
      );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const perms = await this.db
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, ids));
    const counts = await this.db
      .select({ roleId: userRoleAssignments.roleId, n: count() })
      .from(userRoleAssignments)
      .where(inArray(userRoleAssignments.roleId, ids))
      .groupBy(userRoleAssignments.roleId);
    return rows.map((r) => ({
      id: r.id,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      descriptionEn: r.descriptionEn,
      descriptionAr: r.descriptionAr,
      isSystem: r.isSystem,
      grantsAll: r.grantsAll,
      templateKey: r.templateKey,
      permissions: perms
        .filter((p) => p.roleId === r.id)
        .map((p) => p.permissionKey as PermissionKey),
      assignmentCount: counts.find((c) => c.roleId === r.id)?.n ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async get(organizationId: string, id: string): Promise<RoleDto> {
    const role = (await this.list(organizationId)).find((r) => r.id === id);
    if (!role) throw Errors.notFound('Role');
    return role;
  }

  /** Re-check owner-only keys here too: the schema check is not the only line of defence. */
  private assertGrantable(perms: PermissionKey[]): void {
    const bad = perms.filter((p) => PERMISSIONS[p]?.ownerOnly);
    if (bad.length) {
      throw new AppError(
        'owner_only_permission',
        400,
        'These permissions are reserved for Owners',
        { permissions: bad },
      );
    }
  }

  async create(ctx: TenantContext, input: RoleInput): Promise<RoleDto> {
    const perms = [...new Set(input.permissions)];
    this.assertGrantable(perms);
    const id = await this.db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({
          organizationId: ctx.organizationId,
          nameEn: input.nameEn ?? null,
          nameAr: input.nameAr ?? null,
          descriptionEn: input.descriptionEn ?? null,
          descriptionAr: input.descriptionAr ?? null,
        })
        .returning({ id: roles.id });
      if (perms.length) {
        await tx
          .insert(rolePermissions)
          .values(perms.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
      }
      await this.audit.fromCtx(
        ctx,
        'role.created',
        { type: 'role', id: role!.id },
        {
          nameEn: input.nameEn ?? null,
          nameAr: input.nameAr ?? null,
          permissions: perms,
        },
        tx,
      );
      return role!.id;
    });
    return this.get(ctx.organizationId, id);
  }

  async update(ctx: TenantContext, id: string, input: RoleInput): Promise<RoleDto> {
    const before = await this.get(ctx.organizationId, id);
    if (before.isSystem)
      throw new AppError('system_role_locked', 403, 'The Owner role cannot be edited');
    const perms = [...new Set(input.permissions)];
    this.assertGrantable(perms);

    await this.db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({
          nameEn: input.nameEn ?? null,
          nameAr: input.nameAr ?? null,
          descriptionEn: input.descriptionEn ?? null,
          descriptionAr: input.descriptionAr ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(roles.id, id), eq(roles.organizationId, ctx.organizationId)));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (perms.length) {
        await tx
          .insert(rolePermissions)
          .values(perms.map((permissionKey) => ({ roleId: id, permissionKey })));
      }
      await this.audit.fromCtx(
        ctx,
        'role.updated',
        { type: 'role', id },
        {
          added: perms.filter((p) => !before.permissions.includes(p)),
          removed: before.permissions.filter((p) => !perms.includes(p)),
          nameBefore: { en: before.nameEn, ar: before.nameAr },
          nameAfter: { en: input.nameEn ?? null, ar: input.nameAr ?? null },
        },
        tx,
      );
    });
    await this.access.invalidate(ctx.organizationId);
    return this.get(ctx.organizationId, id);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const role = await this.get(ctx.organizationId, id);
    if (role.isSystem)
      throw new AppError('system_role_locked', 403, 'The Owner role cannot be deleted');
    if (role.assignmentCount > 0) {
      throw Errors.conflict('role_in_use', 'Remove this role from all members first');
    }
    const [pending] = await this.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, ctx.organizationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          sql`${invitations.expiresAt} > now()`,
          sql`${invitations.assignments} @> ${JSON.stringify([{ roleId: id }])}::jsonb`,
        ),
      )
      .limit(1);
    if (pending) throw Errors.conflict('role_in_use', 'A pending invitation uses this role');

    await this.db.transaction(async (tx) => {
      await tx
        .delete(roles)
        .where(and(eq(roles.id, id), eq(roles.organizationId, ctx.organizationId)));
      await this.audit.fromCtx(
        ctx,
        'role.deleted',
        { type: 'role', id },
        {
          nameEn: role.nameEn,
          nameAr: role.nameAr,
          permissions: role.permissions,
        },
        tx,
      );
    });
    await this.access.invalidate(ctx.organizationId);
  }
}
