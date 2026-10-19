/**
 * Phase 3 — Contract Builder & Approval, and Phase 4 — Electronic Signatures. Reuses the shared services (access control, audit log,
 * notifications, version history, file store, PDF engine) from SharedServicesModule.
 */
import { Module } from '@nestjs/common';
import { FilesController } from '../files/files.controller';
import { ClauseAssistantService } from './clause-assistant.service';
import { ContractSettingsController } from './contract-settings.controller';
import { ContractTypesController } from './contract-types.controller';
import { ContractTypesService } from './contract-types.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DocumentSettingsService } from './document-settings.service';
import { CLOCK, systemClock } from '../finance/clock';
import { PublicSigningController, SigningController } from './signing.controller';
import { SigningService } from './signing.service';

@Module({
  controllers: [
    FilesController,
    ContractTypesController,
    ContractSettingsController,
    ContractsController,
    SigningController,
    PublicSigningController,
  ],
  providers: [
    ContractTypesService,
    DocumentSettingsService,
    ContractsService,
    ClauseAssistantService,
    SigningService,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [ContractsService],
})
export class ContractsModule {}
