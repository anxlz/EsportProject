import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { DISCORD_CLIENT, HttpDiscordOAuthClient } from './auth/discord.client.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { AccessService } from './authz/access.service.js';
import { AuthGuard, OriginGuard } from './authz/guards.js';
import { GlobalExceptionFilter } from './common/errors.js';
import { RateLimitGuard, RateLimitService } from './common/rate-limit.js';
import type { Env } from './config/env.js';
import { CoreModule } from './core/core.module.js';
import { DepartmentsController } from './departments/departments.controller.js';
import { FinanceModule } from './finance/finance.module.js';
import { GamesController } from './games/games.controller.js';
import { HealthController } from './health.controller.js';
import { MailService } from './mail/mail.service.js';
import { InvitationsController } from './members/invitations.controller.js';
import { InvitationsService } from './members/invitations.service.js';
import { MembersController } from './members/members.controller.js';
import { MembersService } from './members/members.service.js';
import { NotificationService } from './notifications/notification.service.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { ContractTerminationsModule } from './contracts/contract-terminations.module.js';
import { AiModule } from './ai/ai.module.js';
import { AssistantsModule } from './assistants/assistants.module.js';
import { FilesService } from './files/files.service.js';
import { PdfService } from './pdf/pdf.service.js';
import { VersioningService } from './versioning/versioning.service.js';
import { MeetingsModule } from './meetings/meetings.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { SchedulerController } from './scheduler/scheduler.controller.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { NOW, systemNow } from './common/now.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { OrganizationController } from './organizations/organization.controller.js';
import { ProvisioningService } from './organizations/provisioning.service.js';
import { PlatformController } from './platform/platform.controller.js';
import { RolesController } from './roles/roles.controller.js';
import { RolesService } from './roles/roles.service.js';
import { TeamsController } from './teams/teams.controller.js';
import { TeamsService } from './teams/teams.service.js';

/**
 * Cross-cutting services every feature module can inject: authorization, audit log,
 * notifications, sessions, mail, rate limiting, plus (Phase 3) the version history, file store
 * and PDF engine, and (Phase 6) the scheduler and an injectable clock. Built once, reused
 * everywhere (spec §3.3).
 */
const SHARED = [
  AccessService,
  AuditService,
  NotificationService,
  SessionService,
  PasswordService,
  MailService,
  RateLimitService,
  VersioningService,
  FilesService,
  PdfService,
  SchedulerService,
];

@Global()
@Module({
  providers: [...SHARED, { provide: NOW, useValue: systemNow }],
  exports: [...SHARED, NOW],
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
  controllers: [AuditController, NotificationsController, HealthController, SchedulerController],
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
        AiModule,
        FinanceModule,
        ContractsModule,
        ContractTerminationsModule,
        AssistantsModule,
        MeetingsModule,
        IntegrationsModule,
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
