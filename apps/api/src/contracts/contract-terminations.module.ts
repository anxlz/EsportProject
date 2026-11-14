import { Module, type OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import { ContractsModule } from './contracts.module.js';
import { ContractTerminationsController } from './contract-terminations.controller.js';
import { ContractTerminationsService } from './contract-terminations.service.js';

@Module({
  imports: [ContractsModule],
  controllers: [ContractTerminationsController],
  providers: [ContractTerminationsService],
})
export class ContractTerminationsModule implements OnModuleInit {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly terminations: ContractTerminationsService,
  ) {}

  onModuleInit() {
    this.scheduler.register('contract-terminations', () => this.terminations.tick());
  }
}
