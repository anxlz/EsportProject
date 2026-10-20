/**
 * The AI providers (spec §2: one provider interface), shared by the clause assistant and the
 * five assistants. Phase 6 adds Qwen3 next to Anthropic; AiRouter picks one per feature.
 */
import { Global, Module } from '@nestjs/common';
import { type Env, ENV } from '../config/env';
import { AI_PROVIDERS, aiProvidersFromEnv, AiRouter } from './ai.router';

@Global()
@Module({
  providers: [
    { provide: AI_PROVIDERS, inject: [ENV], useFactory: (env: Env) => aiProvidersFromEnv(env) },
    AiRouter,
  ],
  exports: [AI_PROVIDERS, AiRouter],
})
export class AiModule {}
