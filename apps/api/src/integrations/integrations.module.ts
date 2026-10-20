/**
 * Phase 6 — Integrations: Google Calendar, Notion, Obsidian, outgoing and incoming webhooks.
 * Reuses the shared services (audit log, notifications, rate limiter, scheduler, access
 * control) and changes meetings only through MeetingsService, as the connection's owner.
 */
import { Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env';
import { MeetingsModule } from '../meetings/meetings.module';
import { ConnectionsService } from './connections.service';
import { IntegrationHooksController, IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { JobsService } from './jobs.service';
import { ObsidianService } from './obsidian.service';
import { GoogleCalendarProvider } from './providers/google-calendar';
import { NotionProvider } from './providers/notion';
import { RemoteSyncService } from './remote-sync.service';
import { SECRET_BOX, SecretBox } from './secret-box';
import { WebhooksService } from './webhooks.service';
import { IntegrationsWorker } from './worker.service';

@Module({
  imports: [MeetingsModule],
  controllers: [IntegrationHooksController, IntegrationsController],
  providers: [
    {
      provide: SECRET_BOX,
      inject: [ENV],
      useFactory: (env: Env) =>
        new SecretBox({
          encryptionKey: env.INTEGRATIONS_ENCRYPTION_KEY,
          sessionSecret: env.SESSION_SECRET,
        }),
    },
    JobsService,
    ConnectionsService,
    GoogleCalendarProvider,
    NotionProvider,
    RemoteSyncService,
    ObsidianService,
    WebhooksService,
    IntegrationsService,
    IntegrationsWorker,
  ],
  exports: [IntegrationsWorker, JobsService, RemoteSyncService],
})
export class IntegrationsModule {}
