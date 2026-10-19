/**
 * Phase 2 — Accounting & Investment Analysis. Builds on the shared Phase 1 services (access
 * control, audit log, notifications) provided globally by SharedServicesModule; nothing here
 * re-implements them.
 */
import { Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env';
import { RostersController } from '../rosters/rosters.controller';
import { RostersService } from '../rosters/rosters.service';
import { TournamentsController } from '../tournaments/tournaments.controller';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';
import { CLOCK, systemClock } from './clock';
import { PdfRenderer } from './exports/render-pdf';
import { FX_PROVIDER, FrankfurterProvider, NoFxProvider } from './fx.provider';
import { FxService } from './fx.service';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { FinanceSettingsController } from './settings.controller';

@Module({
  controllers: [
    FinanceSettingsController,
    RostersController,
    TournamentsController,
    LedgerController,
    BudgetsController,
    ReportsController,
  ],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: FX_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.FX_PROVIDER === 'frankfurter' ? new FrankfurterProvider(env) : new NoFxProvider(),
    },
    FxService,
    RostersService,
    BudgetsService,
    LedgerService,
    ReportsService,
    PdfRenderer,
  ],
  exports: [RostersService, ReportsService, BudgetsService],
})
export class FinanceModule {}
