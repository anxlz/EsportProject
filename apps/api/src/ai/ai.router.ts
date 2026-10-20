/**
 * Which AI provider answers which feature (Phase 6). The deployer chooses, in the environment:
 * AI_PROVIDER_DEFAULT (anthropic unless set) and AI_PROVIDER_OVERRIDES per feature, e.g.
 * "player_analyst=qwen,email=qwen". Features: the clause assistant and the five assistants.
 *
 * There is deliberately no automatic fallback to the other provider: if a feature is routed to
 * a provider without a key, that feature says it isn't configured, so a deployer who chose
 * where their data goes never has it silently sent somewhere else.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AI_FEATURES,
  type AiFeature,
  type AiProviderName,
  type Env,
  ENV,
  parseProviderOverrides,
} from '../config/env';
import { aiProviderFromEnv, type AiProvider, UnconfiguredProvider } from './ai.provider';
import { QwenProvider } from './qwen.provider';

export type AiProviders = Record<AiProviderName, AiProvider>;
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

export function aiProvidersFromEnv(env: Env): AiProviders {
  return {
    anthropic: aiProviderFromEnv(env),
    qwen: env.QWEN_API_KEY ? new QwenProvider(env) : new UnconfiguredProvider('qwen'),
  };
}

@Injectable()
export class AiRouter {
  private readonly overrides: Map<AiFeature, AiProviderName>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AI_PROVIDERS) private readonly providers: AiProviders,
  ) {
    this.overrides = parseProviderOverrides(env.AI_PROVIDER_OVERRIDES);
  }

  providerName(feature: AiFeature): AiProviderName {
    return this.overrides.get(feature) ?? this.env.AI_PROVIDER_DEFAULT;
  }

  for(feature: AiFeature): AiProvider {
    return this.providers[this.providerName(feature)];
  }

  /** What each feature uses (for status pages; no secrets). */
  describe(feature: AiFeature) {
    const p = this.for(feature);
    return {
      provider: this.providerName(feature),
      configured: p.configured,
      model: p.configured ? p.model : null,
      webSearch: p.supportsWebSearch !== false,
    };
  }

  /** The variable that holds the key for a feature's provider (for "not configured" messages). */
  keyVar(feature: AiFeature) {
    return this.providerName(feature) === 'qwen' ? 'QWEN_API_KEY' : 'ANTHROPIC_API_KEY';
  }

  get features(): readonly AiFeature[] {
    return AI_FEATURES;
  }
}
