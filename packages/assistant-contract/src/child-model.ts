/**
 * A delegated child's model (ADR-0037): the catalog model a persona pins or a
 * delegation names, and the reasoning effort it runs at. One effort scale
 * serves every provider; each model accepts the part of it its own reasoning
 * controls offer, and the shared generation-options builders turn the choice
 * into the request options the composer would send for that model.
 */
import type { AssistantProviderSettings } from '@brainstrike/types';
import {
  buildEffectiveModelSettings,
  buildModelSettings,
  buildProviderOptions,
} from './generation-options.ts';
import { resolveReasoningControlsAvailability } from './model-reasoning.ts';
import { isSupportedProvider, type SupportedProvider } from './provider-metadata.ts';
import { findLlmModelDefinition, resolveModelLabel } from './provider-registry.ts';
import type { RuntimeData } from './runtime-data.ts';

/** The effort scale a delegation speaks, weakest first. */
export const CHILD_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChildEffort = (typeof CHILD_EFFORTS)[number];

/** A child's model, `provider::model`, and the effort it runs at; no effort is the model's own (Auto). */
export interface ChildModelTarget {
  readonly effort?: ChildEffort | undefined;
  readonly modelId: string;
}

/** A child model the delegation cannot run: an unknown model or an effort it does not offer. */
export class ChildModelError extends Error {
  override readonly name = 'ChildModelError';
}

/** `provider::model` split into its catalog identity. */
export function childModelIdentity(modelId: string): {
  readonly model: string;
  readonly provider: SupportedProvider;
} {
  const separator = modelId.indexOf('::');
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 2);
  if (separator <= 0 || model.length === 0 || !isSupportedProvider(provider)) {
    throw new ChildModelError(`"${modelId}" is not a provider::model catalog ID.`);
  }
  return { model, provider };
}

/** The efforts a catalog model accepts, weakest first; none when it has no reasoning control. */
export function childModelEfforts(provider: string, model: string): readonly ChildEffort[] {
  const controls = resolveReasoningControlsAvailability(provider, model);
  if (!controls.available) {
    return [];
  }
  const offered: readonly string[] =
    controls.family === 'google' ? controls.levels : controls.efforts;
  // Anthropic turns thinking off when no effort is set, unless the model always thinks.
  const off = controls.family === 'anthropic' && controls.mandatory !== true;
  return CHILD_EFFORTS.filter((effort) => offered.includes(effort) || (effort === 'none' && off));
}

/** A person's settings for the model's provider with its effort replaced, in that provider's own keys. */
function withEffort(
  provider: string,
  model: string,
  settings: AssistantProviderSettings,
  effort: ChildEffort
): AssistantProviderSettings {
  const controls = resolveReasoningControlsAvailability(provider, model);
  if (!controls.available) {
    return settings;
  }
  switch (controls.family) {
    case 'openai':
    case 'openrouter': {
      const reasoningEffort = controls.efforts.find((value) => value === effort);
      return reasoningEffort ? { ...settings, reasoningEffort } : settings;
    }
    case 'anthropic': {
      const {
        anthropicEffort: _effort,
        anthropicThinkingBudgetTokens: _budget,
        ...rest
      } = settings;
      const anthropicEffort = controls.efforts.find((value) => value === effort);
      return anthropicEffort ? { ...rest, anthropicEffort } : rest;
    }
    case 'bedrock': {
      const bedrockEffort = controls.efforts.find((value) => value === effort);
      return bedrockEffort ? { ...settings, bedrockEffort } : settings;
    }
    case 'google': {
      const googleThinkingLevel = controls.levels.find((value) => value === effort);
      return googleThinkingLevel ? { ...settings, googleThinkingLevel } : settings;
    }
  }
}

/**
 * The model configuration a child on `target` runs with: `settings` are the
 * person's own for that provider, as the composer would apply them, with the
 * target's effort in place of theirs. An effort the model does not offer
 * throws, naming the ones it does.
 */
export function childModelConfiguration(
  target: ChildModelTarget,
  settings: AssistantProviderSettings | undefined
): Pick<RuntimeData, 'model' | 'modelSettings' | 'provider' | 'providerOptions'> & {
  readonly model: string;
  readonly provider: string;
} {
  const { model, provider } = childModelIdentity(target.modelId);
  const base = settings ?? {};
  const { effort } = target;
  if (effort !== undefined) {
    const offered = childModelEfforts(provider, model);
    if (!offered.includes(effort)) {
      const label = resolveModelLabel(provider, model);
      throw new ChildModelError(
        offered.length === 0
          ? `${label} has no reasoning effort to set; leave effort out.`
          : `${label} takes effort ${offered.join(', ')}; "${effort}" is not one of them.`
      );
    }
  }
  const applied = effort === undefined ? base : withEffort(provider, model, base, effort);
  const modelSettings = buildEffectiveModelSettings(
    provider,
    buildModelSettings(applied),
    findLlmModelDefinition(provider, model),
    undefined,
    model,
    applied.reasoningEffort
  );
  const providerOptions = buildProviderOptions(provider, model, applied);
  return {
    model,
    provider,
    ...(modelSettings ? { modelSettings } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}
