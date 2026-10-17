/**
 * Phase 3 — Contract Builder & Approval. Reuses the shared services (access control, audit log,
 * notifications, version history, file store, PDF engine) from SharedServicesModule.
 */
import { Module } from '@nestjs/common';
import { AI_PROVIDER, aiProviderFromEnv } from '../ai/ai.provider';
import { type Env, ENV } from '../config/env';
import { FilesController } from '../files/files.controller';
import { ClauseAssistantService } from './clause-assistant.service';
import { ContractSettingsController } from './contract-settings.controller';
import { ContractTypesController } from './contract-types.controller';
import { ContractTypesService } from './contract-types.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DocumentSettingsService } from './document-settings.service';

@Module({
  controllers: [FilesController, ContractTypesController, ContractSettingsController, ContractsController],
  providers: [
    { provide: AI_PROVIDER, inject: [ENV], useFactory: (env: Env) => aiProviderFromEnv(env) },
    ContractTypesService,
    DocumentSettingsService,
    ContractsService,
    ClauseAssistantService,
  ],
})
export class ContractsModule {}
