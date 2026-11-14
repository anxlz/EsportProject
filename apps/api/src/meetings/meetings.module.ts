/**
 * Phase 6 — Meetings. Reuses the shared services (access control, audit log, notifications,
 * scheduler). Integrations subscribe to MeetingEvents; this module doesn't know about them.
 */
import { Module, type OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import { MeetingEvents } from './meeting-events.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';
import { RemindersService } from './reminders.service.js';

@Module({
  controllers: [MeetingsController],
  providers: [MeetingEvents, MeetingsService, RemindersService],
  exports: [MeetingEvents, MeetingsService, RemindersService],
})
export class MeetingsModule implements OnModuleInit {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly reminders: RemindersService,
  ) {}

  onModuleInit() {
    this.scheduler.register('meeting-reminders', () => this.reminders.tick());
  }
}
