/**
 * Creates a new tenant: the organization row, its default roles (Owner locked + editable
 * templates), the default game catalog, and the first Owner's membership + assignment.
 */
import { Injectable } from '@nestjs/common';
import {
  DEFAULT_BASE_CURRENCY,
  DEFAULT_ENABLED_CURRENCIES,
  DEFAULT_GAMES,
  DEFAULT_ROLE_TEMPLATES,
  type Locale,
} from '@esports/shared';
import { seedContractTypes } from '../contracts/contract-types.service.js';
import type { DbOrTx } from '../db/client.js';
import {
  games,
  organizationMembers,
  organizations,
  rolePermissions,
  roles,
  userRoleAssignments,
} from '../db/schema.js';

@Injectable()
export class ProvisioningService {
  async createOrganization(
    tx: DbOrTx,
    input: { name: string; slug: string; defaultLocale: Locale },
    ownerUserId: string,
  ): Promise<{ organizationId: string; ownerRoleId: string }> {
    const [org] = await tx
      .insert(organizations)
      .values({
        name: input.name,
        slug: input.slug,
        defaultLocale: input.defaultLocale,
        baseCurrency: DEFAULT_BASE_CURRENCY,
        enabledCurrencies: DEFAULT_ENABLED_CURRENCIES,
      })
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

    // Phase 3: the default contract types (player, coach, manager, staff) with sample templates.
    await seedContractTypes(tx, organizationId, ownerUserId);

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
