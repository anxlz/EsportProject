/**
 * Phase 3 — Contract Builder & Approval, and Phase 4 — Electronic Signatures. Reuses the shared services (access control, audit log,
 * notifications, version history, file store, PDF engine) from SharedServicesModule.
 */
import { Module } from '@nestjs/common';
import { FilesController } from '../files/files.controller.js';
import { ClauseAssistantService } from './clause-assistant.service.js';
import { ContractSettingsController } from './contract-settings.controller.js';
import { ContractTypesController } from './contract-types.controller.js';
import { ContractTypesService } from './contract-types.service.js';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';
import { DocumentSettingsService } from './document-settings.service.js';
import { CLOCK, systemClock } from '../finance/clock.js';
import { PublicSigningController, SigningController } from './signing.controller.js';
import { SignerIdService } from './signer-id.service.js';
import { SigningService } from './signing.service.js';

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
    // Not exported: identity documents stay inside the contracts module (never the assistants).
    SignerIdService,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [ContractsService, CLOCK],
})
export class ContractsModule {}
