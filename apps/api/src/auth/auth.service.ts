import { Inject, Injectable } from '@nestjs/common';
import type { Locale, LoginInput, MeResponse, RegisterOrganizationInput } from '@esports/shared';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Access } from '../authz/access.js';
import { AccessService } from '../authz/access.service.js';
import type { AuthContext, ClientMeta } from '../authz/context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, Errors } from '../common/errors.js';
import { randomToken, safeEqual, sha256 } from '../common/crypto.js';
import { type Env, ENV } from '../config/env.js';
import { REDIS } from '../core/core.module.js';
import { DB, type Database } from '../db/client.js';
import {
  organizationMembers,
  organizations,
  passwordResetTokens,
  platformAdmins,
  userIdentities,
  users,
} from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';
import { ProvisioningService } from '../organizations/provisioning.service.js';
import { DISCORD_CLIENT, type DiscordOAuthClient } from './discord.client.js';
import { PasswordService } from './password.service.js';
import { type LoadedSession, SessionService } from './session.service.js';

const RESET_TOKEN_MINUTES = 60;
const OAUTH_STATE_TTL_SECONDS = 600;

interface OAuthState {
  mode: 'login' | 'link';
  userId?: string;
  browserNonceHash: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(DISCORD_CLIENT) private readonly discord: DiscordOAuthClient,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
    private readonly mail: MailService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Registration & login
  // -------------------------------------------------------------------------------------------

  /** Self-service signup creates a NEW organization with the caller as its first Owner. */
  async registerOrganization(
    input: RegisterOrganizationInput,
    meta: ClientMeta,
  ): Promise<LoadedSession> {
    if (!this.env.ORG_SIGNUP_ENABLED) {
      throw new AppError('signup_disabled', 403, 'Organization signup is disabled');
    }
    const [slugTaken] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, input.organizationSlug));
    if (slugTaken) throw Errors.conflict('slug_taken', 'This organization URL is already taken');
    if (await this.findUserByEmail(input.email)) {
      throw Errors.conflict('email_taken', 'An account with this email already exists');
    }

    const passwordHash = await this.passwords.hash(input.password);
    const { userId, organizationId } = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          locale: input.defaultLocale,
          passwordChangedAt: new Date(),
        })
        .returning({ id: users.id });
      const { organizationId } = await this.provisioning.createOrganization(
        tx,
        {
          name: input.organizationName,
          slug: input.organizationSlug,
          defaultLocale: input.defaultLocale,
        },
        user!.id,
      );
      await tx
        .update(users)
        .set({ lastActiveOrganizationId: organizationId })
        .where(eq(users.id, user!.id));
      await this.audit.log(
        {
          organizationId,
          actorUserId: user!.id,
          actorType: 'user',
          action: 'organization.created',
          targetType: 'organization',
          targetId: organizationId,
          metadata: { name: input.organizationName, slug: input.organizationSlug },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return { userId: user!.id, organizationId };
    });
    return this.sessions.create(userId, organizationId, meta);
  }

  async login(input: LoginInput, meta: ClientMeta): Promise<LoadedSession> {
    const user = await this.findUserByEmail(input.email);
    const ok = await this.passwords.verify(input.password, user?.passwordHash ?? null);
    if (!user || !ok) {
      await this.audit.security('auth.login_failed', meta, {
        userId: user?.id ?? null,
        metadata: user ? {} : { emailHash: sha256(input.email) },
      });
      throw new AppError('invalid_credentials', 401, 'Email or password is incorrect');
    }
    return this.startSession(user.id, user.lastActiveOrganizationId, meta, 'password');
  }

  /** Picks the organization to land in, refuses fully-suspended users, creates the session. */
  private async startSession(
    userId: string,
    preferredOrgId: string | null,
    meta: ClientMeta,
    method: 'password' | 'discord' | 'invitation',
  ): Promise<LoadedSession> {
    const orgId = await this.chooseActiveOrganization(userId, preferredOrgId);
    if (orgId === 'suspended') {
      await this.audit.security('auth.login_blocked_suspended', meta, { userId });
      throw new AppError('account_suspended', 401, 'Your access is suspended');
    }
    const session = await this.sessions.create(userId, orgId, meta);
    if (orgId)
      await this.db
        .update(users)
        .set({ lastActiveOrganizationId: orgId })
        .where(eq(users.id, userId));
    await this.audit.security('auth.login', meta, {
      userId,
      organizationId: orgId,
      metadata: { method },
    });
    return session;
  }

  /**
   * Active membership to use: the preferred one if still active, else the oldest active one.
   * Returns null if the user has no memberships (e.g. a platform admin only), or 'suspended' if
   * every membership is suspended and the user is not a platform admin.
   */
  private async chooseActiveOrganization(
    userId: string,
    preferredOrgId: string | null,
  ): Promise<string | null | 'suspended'> {
    const memberships = await this.db
      .select({
        organizationId: organizationMembers.organizationId,
        status: organizationMembers.status,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizationMembers.joinedAt));
    if (!memberships.length) return null;
    const active = memberships.filter((m) => m.status === 'active');
    if (!active.length) return (await this.isPlatformAdmin(userId)) ? null : 'suspended';
    return (
      active.find((m) => m.organizationId === preferredOrgId)?.organizationId ??
      active[0]!.organizationId
    );
  }

  async logout(ctx: AuthContext): Promise<void> {
    await this.sessions.destroy(ctx.session);
    await this.audit.fromCtx(ctx, 'auth.logout', { type: 'user', id: ctx.user.id });
  }

  async switchOrganization(ctx: AuthContext, organizationId: string): Promise<void> {
    const resolved = await this.accessService.resolve(organizationId, ctx.user.id);
    // Same response for "not a member" and "suspended": don't reveal other tenants' existence.
    if (resolved.status !== 'active') throw Errors.notFound('Organization');
    await this.sessions.setActiveOrganization(ctx.session, organizationId);
    await this.db
      .update(users)
      .set({ lastActiveOrganizationId: organizationId })
      .where(eq(users.id, ctx.user.id));
  }

  // -------------------------------------------------------------------------------------------
  // Me
  // -------------------------------------------------------------------------------------------

  async buildMe(userId: string, organizationId: string | null): Promise<MeResponse> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw Errors.unauthenticated();
    const [identity] = await this.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, 'discord')));
    const memberships = await this.db
      .select({
        organizationId: organizationMembers.organizationId,
        status: organizationMembers.status,
        name: organizations.name,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.name));

    let activeOrganization: MeResponse['activeOrganization'] = null;
    let access: Access | null = null;
    if (organizationId) {
      const [org] = await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      const resolved = await this.accessService.resolve(organizationId, userId);
      if (org && resolved.access) {
        activeOrganization = {
          id: org.id,
          name: org.name,
          slug: org.slug,
          defaultLocale: org.defaultLocale,
        };
        access = resolved.access;
      }
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: user.locale,
        hasPassword: !!user.passwordHash,
        discordLinked: !!identity,
        discordUsername: identity?.providerUsername ?? null,
      },
      isPlatformAdmin: await this.isPlatformAdmin(userId),
      activeOrganization,
      memberships,
      isOwner: access?.isOwner ?? false,
      permissions: access?.toJSON() ?? [],
    };
  }

  async updateProfile(ctx: AuthContext, input: { displayName?: string; locale?: Locale | null }) {
    await this.db
      .update(users)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(users.id, ctx.user.id));
  }

  // -------------------------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------------------------

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async forgotPassword(email: string, meta: ClientMeta): Promise<void> {
    const user = await this.findUserByEmail(email);
    await this.audit.security('auth.password_reset_requested', meta, {
      userId: user?.id ?? null,
      metadata: user ? {} : { emailHash: sha256(email) },
    });
    if (!user) return;

    const token = randomToken(32);
    await this.db.transaction(async (tx) => {
      // Only the newest link works.
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000),
        requestedIp: meta.ip,
      });
    });
    const url = `${this.env.WEB_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mail.sendPasswordReset(
      user.email,
      { url, minutes: RESET_TOKEN_MINUTES },
      user.locale ?? 'en',
    );
  }

  async resetPassword(token: string, newPassword: string, meta: ClientMeta): Promise<void> {
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, sha256(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      );
    if (!row)
      throw new AppError('invalid_or_expired_token', 400, 'This link is invalid or has expired');

    const passwordHash = await this.passwords.hash(newPassword);
    await this.db.transaction(async (tx) => {
      // Conditional update guards against two concurrent uses of the same token.
      const claimed = await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
        .returning({ id: passwordResetTokens.id });
      if (!claimed.length) throw new AppError('invalid_or_expired_token', 400);
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(users.id, row.userId));
    });
    const revoked = await this.sessions.destroyAllForUser(row.userId);
    await this.audit.security('auth.password_reset_completed', meta, {
      userId: row.userId,
      metadata: { sessionsRevoked: revoked },
    });
    const [user] = await this.db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, row.userId));
    if (user) await this.mail.sendPasswordChanged(user.email, user.locale ?? 'en');
  }

  async changePassword(ctx: AuthContext, current: string, next: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, ctx.user.id));
    if (!user || !(await this.passwords.verify(current, user.passwordHash))) {
      await this.audit.security('auth.password_change_failed', ctx, { userId: ctx.user.id });
      throw new AppError('invalid_credentials', 400, 'Current password is incorrect');
    }
    await this.db
      .update(users)
      .set({
        passwordHash: await this.passwords.hash(next),
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, ctx.user.id));
    const revoked = await this.sessions.destroyAllForUser(ctx.user.id, {
      exceptKey: ctx.session.key,
    });
    await this.audit.fromCtx(
      ctx,
      'auth.password_changed',
      { type: 'user', id: ctx.user.id },
      {
        otherSessionsRevoked: revoked,
      },
    );
    await this.mail.sendPasswordChanged(user.email, user.locale ?? 'en');
  }

  async revokeOtherSessions(ctx: AuthContext): Promise<number> {
    const revoked = await this.sessions.destroyAllForUser(ctx.user.id, {
      exceptKey: ctx.session.key,
    });
    await this.audit.fromCtx(
      ctx,
      'auth.sessions_revoked',
      { type: 'user', id: ctx.user.id },
      { revoked },
    );
    return revoked;
  }

  // -------------------------------------------------------------------------------------------
  // Discord OAuth (login for already-linked accounts, and linking from settings)
  // -------------------------------------------------------------------------------------------

  /**
   * Returns the Discord authorize URL and a browser nonce. The nonce goes into a short-lived
   * cookie and must come back with the callback, binding the flow to the browser that started
   * it (prevents login-CSRF: an attacker cannot make a victim finish the attacker's flow).
   */
  async discordStart(
    mode: 'login' | 'link',
    ctx: AuthContext | null,
  ): Promise<{ url: string; nonce: string }> {
    if (!this.env.discordEnabled)
      throw new AppError('discord_not_configured', 503, 'Discord login is not configured');
    if (mode === 'link' && !ctx) throw Errors.unauthenticated();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const value: OAuthState = { mode, userId: ctx?.user.id, browserNonceHash: sha256(nonce) };
    await this.redis.set(
      `oauth:discord:${state}`,
      JSON.stringify(value),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );
    return { url: this.discord.authorizeUrl(state), nonce };
  }

  /** Returns the web-app path to redirect to (with ?error=… on failure). */
  async discordCallback(
    params: { code?: string; state?: string; nonce?: string },
    meta: ClientMeta,
  ): Promise<{ redirect: string; session?: LoadedSession }> {
    const fail = (code: string, base = '/login') => ({ redirect: `${base}?error=${code}` });
    if (!params.state) return fail('oauth_state_invalid');
    // Consume the state on ANY attempt, so an intercepted state value is good for one try only.
    const raw =
      params.state.length <= 100 ? await this.redis.getdel(`oauth:discord:${params.state}`) : null;
    if (!raw || !params.code || !params.nonce) return fail('oauth_state_invalid');
    const state = JSON.parse(raw) as OAuthState;
    if (!safeEqual(state.browserNonceHash, sha256(params.nonce)))
      return fail('oauth_state_invalid');
    const base = state.mode === 'link' ? '/dashboard/settings' : '/login';

    let profile;
    try {
      profile = await this.discord.fetchProfile(params.code);
    } catch {
      return fail('internal_error', base);
    }

    const [identity] = await this.db
      .select()
      .from(userIdentities)
      .where(
        and(eq(userIdentities.provider, 'discord'), eq(userIdentities.providerUserId, profile.id)),
      );

    if (state.mode === 'login') {
      // Deliberately no auto-link by email: an email match alone is not proof of account ownership.
      if (!identity) return fail('discord_not_linked');
      const [user] = await this.db.select().from(users).where(eq(users.id, identity.userId));
      if (!user) return fail('discord_not_linked');
      try {
        const session = await this.startSession(
          user.id,
          user.lastActiveOrganizationId,
          meta,
          'discord',
        );
        return { redirect: '/dashboard', session };
      } catch (e) {
        return fail(e instanceof AppError ? e.code : 'internal_error');
      }
    }

    // mode === 'link'
    const userId = state.userId!;
    if (identity) {
      return identity.userId === userId
        ? { redirect: `${base}?discord=linked` }
        : fail('discord_already_linked', base);
    }
    const [existing] = await this.db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, 'discord')));
    if (existing) return fail('discord_already_linked', base);
    await this.db.insert(userIdentities).values({
      userId,
      provider: 'discord',
      providerUserId: profile.id,
      providerUsername: profile.globalName ?? profile.username,
    });
    await this.audit.security('auth.discord_linked', meta, {
      userId,
      metadata: { discordId: profile.id },
    });
    return { redirect: `${base}?discord=linked` };
  }

  async unlinkDiscord(ctx: AuthContext): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, ctx.user.id));
    if (!user?.passwordHash) {
      // Would leave the account with no way to sign in.
      throw Errors.badRequest('validation_failed', 'Set a password before unlinking Discord');
    }
    await this.db
      .delete(userIdentities)
      .where(and(eq(userIdentities.userId, ctx.user.id), eq(userIdentities.provider, 'discord')));
    await this.audit.fromCtx(ctx, 'auth.discord_unlinked', { type: 'user', id: ctx.user.id });
  }

  // -------------------------------------------------------------------------------------------

  async findUserByEmail(email: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
    return user ?? null;
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: platformAdmins.userId })
      .from(platformAdmins)
      .where(eq(platformAdmins.userId, userId));
    return !!row;
  }

  /** Used by invitation acceptance, which creates the session itself. */
  createSessionFor(
    userId: string,
    organizationId: string,
    meta: ClientMeta,
  ): Promise<LoadedSession> {
    return this.startSession(userId, organizationId, meta, 'invitation');
  }
}
