/**
 * Phase 2 — Accounting & Investment Analysis. Builds on the shared Phase 1 services (access
 * control, audit log, notifications) provided globally by SharedServicesModule; nothing here
 * re-implements them.
 */
import { Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env.js';
import { RostersController } from '../rosters/rosters.controller.js';
import { RostersService } from '../rosters/rosters.service.js';
import { TournamentsController } from '../tournaments/tournaments.controller.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';
import { CLOCK, systemClock } from './clock.js';
import { PdfRenderer } from './exports/render-pdf.js';
import { FX_PROVIDER, FrankfurterProvider, NoFxProvider } from './fx.provider.js';
import { FxService } from './fx.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { FinanceSettingsController } from './settings.controller.js';

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
