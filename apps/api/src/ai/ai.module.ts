/** The one AI provider (spec §2), shared by the clause assistant and the five assistants. */
import { Global, Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env';
import { AI_PROVIDER, aiProviderFromEnv } from './ai.provider';

@Global()
@Module({
  providers: [
    { provide: AI_PROVIDER, inject: [ENV], useFactory: (env: Env) => aiProviderFromEnv(env) },
  ],
  exports: [AI_PROVIDER],
})
export class AiModule {}
