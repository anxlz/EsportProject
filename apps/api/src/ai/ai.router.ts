/**
 * Which AI provider answers which feature (Phase 6). The deployer chooses, in the environment:
 * LLM_PROVIDER / legacy AI_PROVIDER_DEFAULT select the default and AI_PROVIDER_OVERRIDES routes
 * individual features. Features: the clause assistant and the five assistants.
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
} from '../config/env.js';
import { aiProviderFromEnv, type AiProvider, UnconfiguredProvider } from './ai.provider.js';
import { LocalLlmProvider } from './local-llm.provider.js';
import { QwenProvider } from './qwen.provider.js';

export type AiProviders = Record<AiProviderName, AiProvider>;
export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

export function aiProvidersFromEnv(env: Env): AiProviders {
  return {
    anthropic: aiProviderFromEnv(env),
    qwen: env.QWEN_API_KEY ? new QwenProvider(env) : new UnconfiguredProvider('qwen'),
    local: new LocalLlmProvider(env),
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
    return (
      this.overrides.get(feature) ??
      this.env.LLM_PROVIDER ??
      this.env.AI_PROVIDER_DEFAULT ??
      (this.env.ANTHROPIC_API_KEY ? 'anthropic' : 'local')
    );
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

  localHealth() {
    const provider = this.providers.local;
    return provider.health
      ? provider.health()
      : Promise.resolve({
          ok: false,
          model: provider.model ?? '',
          latencyMs: 0,
          reason: 'unsupported',
        });
  }

  /** The variable that holds the key for a feature's provider (for "not configured" messages). */
  keyVar(feature: AiFeature) {
    const name = this.providerName(feature);
    return name === 'qwen' ? 'QWEN_API_KEY' : name === 'local' ? 'LLM_MODEL' : 'ANTHROPIC_API_KEY';
  }

  get features(): readonly AiFeature[] {
    return AI_FEATURES;
  }
}
