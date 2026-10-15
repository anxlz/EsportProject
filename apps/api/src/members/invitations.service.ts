/**
 * Invitation-based provisioning: the only way to join an existing organization.
 * Tokens are 256-bit random, stored as SHA-256 hashes, single-use, and expire after 7 days.
 * The plain link is shown once to the inviter (to copy) and emailed when mail is configured.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateInvitationInput,
  InvitationDto,
  PublicInvitationDto,
  RoleAssignmentInput,
} from '@esports/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AccessService } from '../authz/access.service';
import type { AuthContext, ClientMeta, TenantContext } from '../authz/context';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { type LoadedSession, SessionService } from '../auth/session.service';
import { AppError, Errors } from '../common/errors';
import { randomToken, sha256 } from '../common/crypto';
import { type Env, ENV } from '../config/env';
import { DB, type Database, type DbOrTx } from '../db/client';
import {
  invitations,
  organizationMembers,
  organizations,
  roles,
  userRoleAssignments,
  users,
} from '../db/schema';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../notifications/notification.service';
import { normalizeAssignments } from './assignments';

const INVITATION_TTL_DAYS = 7;

type InvitationRow = typeof invitations.$inferSelect;

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notifications: NotificationService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  private toDto(
    row: InvitationRow,
    inviter: { id: string; displayName: string } | null,
  ): InvitationDto {
    return {
      id: row.id,
      email: row.email,
      makeOwner: row.makeOwner,
      assignments: row.assignments,
      invitedBy: inviter,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async create(
    ctx: TenantContext,
    input: CreateInvitationInput,
  ): Promise<{ invitation: InvitationDto; inviteUrl: string; emailSent: boolean }> {
    if (input.makeOwner && !ctx.access.has('org.ownership.manage')) throw Errors.forbidden();

    const [alreadyMember] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.organizationId),
          sql`lower(${users.email}) = ${input.email}`,
        ),
      );
    if (alreadyMember) throw Errors.conflict('already_member', 'This person is already a member');

    const token = randomToken(32);
    const row = await this.db.transaction(async (tx) => {
      const { valid } = await normalizeAssignments(tx, ctx.organizationId, input.assignments);
      // One live invitation per email per organization.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.organizationId, ctx.organizationId),
            eq(invitations.email, input.email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      const [inv] = await tx
        .insert(invitations)
        .values({
          organizationId: ctx.organizationId,
          email: input.email,
          tokenHash: sha256(token),
          assignments: valid.map((a) => ({
            roleId: a.roleId,
            scopeType: a.scopeType,
            scopeId: a.departmentId ?? a.teamId,
          })),
          makeOwner: !!input.makeOwner,
          invitedByUserId: ctx.user.id,
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000),
        })
        .returning();
      await this.audit.fromCtx(
        ctx,
        'invitation.created',
        { type: 'invitation', id: inv!.id },
        {
          email: input.email,
          makeOwner: !!input.makeOwner,
          assignments: inv!.assignments,
        },
        tx,
      );
      return inv!;
    });

    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, ctx.organizationId));
    const inviteUrl = `${this.env.WEB_APP_URL}/invite/${token}`;
    const emailSent = await this.mail.sendInvitation(input.email, {
      organizationName: org?.name ?? '',
      inviterName: ctx.user.displayName,
      url: inviteUrl,
      expiresAt: row.expiresAt,
    });
    return {
      invitation: this.toDto(row, { id: ctx.user.id, displayName: ctx.user.displayName }),
      inviteUrl,
      emailSent,
    };
  }

  async listPending(organizationId: string): Promise<InvitationDto[]> {
    const rows = await this.db
      .select({ inv: invitations, inviterName: users.displayName })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(
        and(
          eq(invitations.organizationId, organizationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt));
    return rows.map(({ inv, inviterName }) =>
      this.toDto(
        inv,
        inv.invitedByUserId ? { id: inv.invitedByUserId, displayName: inviterName ?? '' } : null,
      ),
    );
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    const updated = await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.organizationId, ctx.organizationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id, email: invitations.email });
    if (!updated.length) throw Errors.notFound('Invitation');
    await this.audit.fromCtx(
      ctx,
      'invitation.revoked',
      { type: 'invitation', id },
      { email: updated[0]!.email },
    );
  }

  // --- Public (token-holder) side ---------------------------------------------------------

  private async findValid(token: string): Promise<InvitationRow> {
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, sha256(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    if (!row)
      throw new AppError(
        'invalid_or_expired_token',
        404,
        'This invitation is invalid or has expired',
      );
    return row;
  }

  async getPublic(token: string): Promise<PublicInvitationDto> {
    const row = await this.findValid(token);
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, row.organizationId));
    const [inviter] = row.invitedByUserId
      ? await this.db
          .select({ name: users.displayName })
          .from(users)
          .where(eq(users.id, row.invitedByUserId))
      : [];
    return {
      organizationName: org?.name ?? '',
      email: row.email,
      inviterName: inviter?.name ?? null,
      expiresAt: row.expiresAt.toISOString(),
      accountExists: !!(await this.auth.findUserByEmail(row.email)),
    };
  }

  /** New user: create the account and join. Existing accounts must sign in and use acceptAsUser. */
  async acceptAsNewUser(
    token: string,
    input: { displayName: string; password: string },
    meta: ClientMeta,
  ): Promise<LoadedSession> {
    const row = await this.findValid(token);
    if (await this.auth.findUserByEmail(row.email)) {
      throw Errors.conflict(
        'login_required',
        'An account with this email exists. Sign in to accept.',
      );
    }
    const passwordHash = await this.passwords.hash(input.password);
    const userId = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: row.email,
          passwordHash,
          displayName: input.displayName,
          passwordChangedAt: new Date(),
        })
        .returning({ id: users.id });
      await this.join(tx, row, user!.id, meta);
      return user!.id;
    });
    await this.afterJoin(row, userId);
    return this.auth.createSessionFor(userId, row.organizationId, meta);
  }

  async acceptAsUser(ctx: AuthContext, token: string): Promise<void> {
    const row = await this.findValid(token);
    if (ctx.user.email.toLowerCase() !== row.email.toLowerCase()) {
      throw new AppError(
        'email_mismatch',
        403,
        'This invitation was sent to a different email address',
      );
    }
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, row.organizationId),
            eq(organizationMembers.userId, ctx.user.id),
          ),
        );
      if (existing)
        throw Errors.conflict('already_member', 'You are already a member of this organization');
      await this.join(tx, row, ctx.user.id, ctx);
    });
    await this.afterJoin(row, ctx.user.id);
    await this.sessions.setActiveOrganization(ctx.session, row.organizationId);
    await this.db
      .update(users)
      .set({ lastActiveOrganizationId: row.organizationId })
      .where(eq(users.id, ctx.user.id));
  }

  private async join(
    tx: DbOrTx,
    row: InvitationRow,
    userId: string,
    meta: ClientMeta,
  ): Promise<void> {
    // Single-use: claim the invitation atomically.
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: userId })
      .where(
        and(
          eq(invitations.id, row.id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (!claimed.length) throw new AppError('invalid_or_expired_token', 404);

    await tx.insert(organizationMembers).values({
      organizationId: row.organizationId,
      userId,
      invitedByUserId: row.invitedByUserId,
    });

    const { valid, dropped } = await normalizeAssignments(
      tx,
      row.organizationId,
      row.assignments as RoleAssignmentInput[],
      { skipInvalid: true },
    );
    if (valid.length) {
      await tx.insert(userRoleAssignments).values(
        valid.map((a) => ({
          ...a,
          organizationId: row.organizationId,
          userId,
          createdByUserId: row.invitedByUserId,
        })),
      );
    }
    if (row.makeOwner) {
      const [ownerRole] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.organizationId, row.organizationId), eq(roles.isSystem, true)));
      await tx.insert(userRoleAssignments).values({
        organizationId: row.organizationId,
        userId,
        roleId: ownerRole!.id,
        scopeType: 'organization',
        createdByUserId: row.invitedByUserId,
      });
    }

    await this.audit.log(
      {
        organizationId: row.organizationId,
        actorUserId: userId,
        actorType: 'user',
        action: 'invitation.accepted',
        targetType: 'invitation',
        targetId: row.id,
        metadata: {
          makeOwner: row.makeOwner,
          assignments: valid.length,
          droppedAssignments: dropped,
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx,
    );

    if (row.invitedByUserId) {
      const [newUser] = await tx
        .select({ name: users.displayName })
        .from(users)
        .where(eq(users.id, userId));
      // Only notify the inviter if they are still a member.
      const [inviterMember] = await tx
        .select({ status: organizationMembers.status })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, row.organizationId),
            eq(organizationMembers.userId, row.invitedByUserId),
          ),
        );
      if (inviterMember) {
        await this.notifications.notify(
          {
            organizationId: row.organizationId,
            recipientUserIds: [row.invitedByUserId],
            type: 'member.joined',
            data: { memberName: newUser?.name ?? '', memberUserId: userId },
            link: '/dashboard/members',
          },
          tx,
        );
      }
    }
  }

  private async afterJoin(row: InvitationRow, _userId: string): Promise<void> {
    await this.access.invalidate(row.organizationId);
  }
}
