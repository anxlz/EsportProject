/**
 * Phase 6 — Integrations: Google Calendar, Notion, Obsidian, outgoing and incoming webhooks.
 * Reuses the shared services (audit log, notifications, rate limiter, scheduler, access
 * control) and changes meetings only through MeetingsService, as the connection's owner.
 */
import { Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env.js';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { ConnectionsService } from './connections.service.js';
import { IntegrationHooksController, IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { JobsService } from './jobs.service.js';
import { ObsidianService } from './obsidian.service.js';
import { GoogleCalendarProvider } from './providers/google-calendar.js';
import { NotionProvider } from './providers/notion.js';
import { RemoteSyncService } from './remote-sync.service.js';
import { SECRET_BOX, SecretBox } from './secret-box.js';
import { WebhooksService } from './webhooks.service.js';
import { IntegrationsWorker } from './worker.service.js';

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
