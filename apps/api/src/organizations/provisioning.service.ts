/**
 * Creates a new tenant: the organization row, its default roles (Owner locked + editable
 * templates), the default game catalog, and the first Owner's membership + assignment.
 */
import { Injectable } from '@nestjs/common';
import { DEFAULT_GAMES, DEFAULT_ROLE_TEMPLATES, type Locale } from '@esports/shared';
import type { DbOrTx } from '../db/client';
import {
  games,
  organizationMembers,
  organizations,
  rolePermissions,
  roles,
  userRoleAssignments,
} from '../db/schema';

@Injectable()
export class ProvisioningService {
  async createOrganization(
    tx: DbOrTx,
    input: { name: string; slug: string; defaultLocale: Locale },
    ownerUserId: string,
  ): Promise<{ organizationId: string; ownerRoleId: string }> {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name, slug: input.slug, defaultLocale: input.defaultLocale })
      .returning({ id: organizations.id });
    const organizationId = org!.id;

    let ownerRoleId = '';
    for (const t of DEFAULT_ROLE_TEMPLATES) {
      const [role] = await tx
        .insert(roles)
        .values({
          organizationId,
          nameEn: t.nameEn,
          nameAr: t.nameAr,
          descriptionEn: t.descriptionEn,
          descriptionAr: t.descriptionAr,
          isSystem: t.grantsAll,
          grantsAll: t.grantsAll,
          templateKey: t.templateKey,
        })
        .returning({ id: roles.id });
      if (t.grantsAll) ownerRoleId = role!.id;
      if (t.permissions.length) {
        await tx
          .insert(rolePermissions)
          .values(t.permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
      }
    }

    await tx.insert(games).values(
      DEFAULT_GAMES.map((g, i) => ({
        organizationId,
        name: g.name,
        shortName: g.shortName,
        sortOrder: i,
      })),
    );

    await tx.insert(organizationMembers).values({ organizationId, userId: ownerUserId });
    await tx.insert(userRoleAssignments).values({
      organizationId,
      userId: ownerUserId,
      roleId: ownerRoleId,
      scopeType: 'organization',
      createdByUserId: ownerUserId,
    });

    return { organizationId, ownerRoleId };
  }
}
