/**
 * Phase 5 — AI Assistants. Reuses the shared services (access control, audit log, rate limiter,
 * mail) and reads platform data only through the existing finance, roster, team and contract
 * services, with the invoking user's own permissions.
 */
import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module.js';
import { CLOCK, systemClock } from '../finance/clock.js';
import { FinanceModule } from '../finance/finance.module.js';
import { TeamsService } from '../teams/teams.service.js';
import { AssistantEngine } from './assistant-engine.js';
import { AssistantTools } from './assistant-tools.js';
import { AssistantsController } from './assistants.controller.js';
import { AssistantsService } from './assistants.service.js';

@Module({
  imports: [ContractsModule, FinanceModule],
  controllers: [AssistantsController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    TeamsService,
    AssistantTools,
    AssistantEngine,
    AssistantsService,
  ],
  exports: [AssistantEngine],
})
export class AssistantsModule {}
