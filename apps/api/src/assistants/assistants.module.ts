/**
 * Phase 5 — AI Assistants. Reuses the shared services (access control, audit log, rate limiter,
 * mail) and reads platform data only through the existing finance, roster, team and contract
 * services, with the invoking user's own permissions.
 */
import { Module } from '@nestjs/common';
import { ContractsModule } from '../contracts/contracts.module';
import { CLOCK, systemClock } from '../finance/clock';
import { FinanceModule } from '../finance/finance.module';
import { TeamsService } from '../teams/teams.service';
import { AssistantEngine } from './assistant-engine';
import { AssistantTools } from './assistant-tools';
import { AssistantsController } from './assistants.controller';
import { AssistantsService } from './assistants.service';

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
