import { Module, type OnModuleInit } from '@nestjs/common';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ContractsModule } from './contracts.module';
import { ContractTerminationsController } from './contract-terminations.controller';
import { ContractTerminationsService } from './contract-terminations.service';

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
