import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { DISCORD_CLIENT, HttpDiscordOAuthClient } from './auth/discord.client';
import { PasswordService } from './auth/password.service';
import { SessionService } from './auth/session.service';
import { AccessService } from './authz/access.service';
import { AuthGuard, OriginGuard } from './authz/guards';
import { GlobalExceptionFilter } from './common/errors';
import { RateLimitGuard, RateLimitService } from './common/rate-limit';
import type { Env } from './config/env';
import { CoreModule } from './core/core.module';
import { DepartmentsController } from './departments/departments.controller';
import { GamesController } from './games/games.controller';
import { HealthController } from './health.controller';
import { MailService } from './mail/mail.service';
import { InvitationsController } from './members/invitations.controller';
import { InvitationsService } from './members/invitations.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { NotificationService } from './notifications/notification.service';
import { NotificationsController } from './notifications/notifications.controller';
import { OrganizationController } from './organizations/organization.controller';
import { ProvisioningService } from './organizations/provisioning.service';
import { PlatformController } from './platform/platform.controller';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { TeamsController } from './teams/teams.controller';
import { TeamsService } from './teams/teams.service';

/**
 * Cross-cutting services every feature module can inject: authorization, audit log,
 * notifications, sessions, mail, rate limiting. Built once, reused everywhere (spec §3.3).
 */
@Global()
@Module({
  providers: [
    AccessService,
    AuditService,
    NotificationService,
    SessionService,
    PasswordService,
    MailService,
    RateLimitService,
  ],
  exports: [
    AccessService,
    AuditService,
    NotificationService,
    SessionService,
    PasswordService,
    MailService,
    RateLimitService,
  ],
})
export class SharedServicesModule {}

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    ProvisioningService,
    { provide: DISCORD_CLIENT, useClass: HttpDiscordOAuthClient },
  ],
  exports: [AuthService, ProvisioningService],
})
export class AuthModule {}

@Module({
  imports: [AuthModule],
  controllers: [MembersController, InvitationsController, RolesController],
  providers: [MembersService, InvitationsService, RolesService],
  exports: [MembersService],
})
export class AccessManagementModule {}

@Module({
  controllers: [OrganizationController, DepartmentsController, TeamsController, GamesController],
  providers: [TeamsService],
})
export class OrganizationStructureModule {}

@Module({
  controllers: [AuditController, NotificationsController, HealthController],
})
export class ActivityModule {}

@Module({
  imports: [AccessManagementModule],
  controllers: [PlatformController],
})
export class PlatformModule {}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(env),
        SharedServicesModule,
        AuthModule,
        AccessManagementModule,
        OrganizationStructureModule,
        ActivityModule,
        PlatformModule,
      ],
      providers: [
        // Guard order matters: CSRF origin check → rate limit → session/permission enforcement.
        { provide: APP_GUARD, useClass: OriginGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    };
  }
}
