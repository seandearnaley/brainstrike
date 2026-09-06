/**
 * Model-selection reconcile — the decision, as a value.
 *
 * BST-1652. This logic used to be a `useEffect` in
 * `assistant-ui-panel-wrapper.tsx` that called `setModel`/`clearModel` through
 * six `useCallback` helpers. It had the "effect-dep double duty" problem: the
 * only way to ask what it decided (and why) was to mount the whole 1,900-line
 * wrapper and inspect the preferences store afterwards, and the ORDER in which
 * its branches ran depended on React commit order rather than on anything
 * stated in the code.
 *
 * `reconcileModelSelection` is a pure function of a plain input snapshot. It
 * DECIDES; the caller APPLIES. No React, no PGlite, no store handles — so every
 * branch is unit-testable (`__tests__/model-selection-reconcile.test.ts`) and a
 * decision can be logged verbatim.
 *
 * Branch order is load-bearing and mirrors the pre-extraction effect exactly.
 */

import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  findFirstProviderWithEnabledModels,
  hasValidProviderModelSelection,
  isLocalRuntimeProvider,
  type LlmProviderModelDefinition,
  resolveModelNameFromComposite,
  resolveProviderModelSelection,
} from '../assistant-ui-panel-wrapper-runtime';

/** Provider discovery lifecycle, as reported by `useConfiguredAssistantProviders`. */
export type AssistantProviderDiscoveryState = 'error' | 'idle' | 'inactive' | 'loading' | 'ready';

export interface ModelSelectionReconcileInputs {
  /** Providers discovery says are usable right now. */
  readonly configuredProviders: readonly SupportedProvider[];
  readonly discoveryState: AssistantProviderDiscoveryState;
  /**
   * Built-in local models that are DOWNLOADED (and preference- or
   * registry-enabled). The built-in local provider advertises no catalog
   * entries, so this list — not `getProviderLlmModels('local')` — is what makes
   * it selectable.
   */
  readonly enabledBuiltInLocalModelIds: readonly string[];
  /** Registry-enabled model ids (DB is the source of truth). */
  readonly enabledModelIds: ReadonlySet<string>;
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  /**
   * The selection as captured by the RENDER that scheduled this reconcile.
   * Deliberately distinct from `selectedModel` below: the pre-extraction effect
   * gated built-in-local seeding on the subscribed render value while every
   * other branch read the live store through `getSelectedModel()`. The two can
   * differ for one pass if a write lands between commit and effect flush. The
   * divergence is PRESERVED here rather than quietly collapsed; collapsing it
   * is a separate, deliberate change.
   */
  readonly renderedSelectedModel: string | null;
  /** Live `getSelectedModel()` — the composite `provider::model` key, or null. */
  readonly selectedModel: string | null;
  /** Live `getSelectedProvider()`. Parsed by the store, not re-derived here. */
  readonly selectedProvider: SupportedProvider | null;
}

/** Why the reconcile left the current selection alone. */
export type ModelSelectionKeepReason =
  /** A candidate provider passed the "has enabled models" gate but yielded no id. */
  | 'candidate-provider-has-no-selectable-model'
  /** Discovery has not produced a usable answer yet — never act on a blank slate. */
  | 'discovery-pending'
  /** The selected local-runtime provider is simply not something discovery reports. */
  | 'local-runtime-provider-not-discovered'
  /** The selected local-runtime model is still in the runtime's catalog. */
  | 'local-runtime-selection-valid'
  /** Nothing selected and nothing to select. */
  | 'nothing-selected-and-nothing-available'
  /** The current provider/model pair is still configured and enabled. */
  | 'selection-valid';

/** Why the reconcile chose a model. */
export type ModelSelectionSelectReason =
  /** The selected local-runtime model vanished; another one from the same runtime took its place. */
  | 'local-runtime-model-reselected'
  /** First configured provider with an enabled model, per the registry. */
  | 'reconciled-from-registry'
  /** First run with a downloaded built-in local model and no selection at all. */
  | 'seeded-built-in-local-default';

/** Why the reconcile dropped the selection. */
export type ModelSelectionClearReason =
  /** No configured provider has an enabled model left. */
  | 'no-provider-has-enabled-models'
  /** The selected provider is no longer configured (and is not a local runtime). */
  | 'provider-unavailable';

export type ModelSelectionDecision =
  | { readonly kind: 'clear'; readonly reason: ModelSelectionClearReason }
  | { readonly kind: 'keep'; readonly reason: ModelSelectionKeepReason }
  | {
      readonly compositeKey: string;
      readonly kind: 'select';
      readonly reason: ModelSelectionSelectReason;
    };

function isModelEnabled(inputs: ModelSelectionReconcileInputs, modelId: string): boolean {
  return inputs.enabledModelIds.has(modelId);
}

function providerHasEnabledModels(
  inputs: ModelSelectionReconcileInputs,
  provider: SupportedProvider
): boolean {
  if (provider === 'local' && inputs.enabledBuiltInLocalModelIds.length > 0) {
    return true;
  }
  return inputs
    .getProviderLlmModels(provider)
    .some((definition) => inputs.enabledModelIds.has(definition.id));
}

/** The model this provider would be set to, or undefined when it can offer none. */
function resolveModelForProvider(
  inputs: ModelSelectionReconcileInputs,
  provider: SupportedProvider
): string | undefined {
  const fromCatalog = resolveProviderModelSelection({
    getProviderLlmModels: inputs.getProviderLlmModels,
    isModelEnabled: (_providerId, modelId) => isModelEnabled(inputs, modelId),
    provider,
  });
  if (fromCatalog) {
    return fromCatalog;
  }
  return provider === 'local' ? inputs.enabledBuiltInLocalModelIds[0] : undefined;
}

function resolveSeedDecision(
  inputs: ModelSelectionReconcileInputs
): ModelSelectionDecision | undefined {
  if (inputs.renderedSelectedModel !== null || !inputs.configuredProviders.includes('local')) {
    return;
  }
  const localModel = inputs.enabledBuiltInLocalModelIds[0];
  if (!(localModel && inputs.enabledModelIds.has(localModel))) {
    return;
  }
  return {
    compositeKey: `local::${localModel}`,
    kind: 'select',
    reason: 'seeded-built-in-local-default',
  };
}

function shouldSkipReconcile(inputs: ModelSelectionReconcileInputs): boolean {
  return (
    inputs.discoveryState === 'idle' ||
    inputs.discoveryState === 'loading' ||
    (inputs.configuredProviders.length === 0 && !isLocalRuntimeProvider(inputs.selectedProvider))
  );
}

/**
 * The local-runtime leg. Ollama/LM Studio catalogs come from a live localhost
 * probe rather than the registry, so a selection there is validated against the
 * runtime's own model list and never cleared just because discovery does not
 * list the provider. `undefined` means "not a local-runtime case, fall through".
 */
function resolveLocalRuntimeDecision(
  inputs: ModelSelectionReconcileInputs,
  provider: SupportedProvider
): ModelSelectionDecision | undefined {
  if (!isLocalRuntimeProvider(provider)) {
    return;
  }
  const currentModelName = resolveModelNameFromComposite(inputs.selectedModel);
  if (currentModelName && isModelEnabled(inputs, currentModelName)) {
    return { kind: 'keep', reason: 'local-runtime-selection-valid' };
  }
  if (!providerHasEnabledModels(inputs, provider)) {
    return;
  }
  const replacement = resolveModelForProvider(inputs, provider);
  if (!replacement) {
    // Matches the pre-extraction effect: `resolveLocalRuntimeSelection` reported
    // "handled" and returned even when `selectModelForProvider` had nothing to set.
    return { kind: 'keep', reason: 'candidate-provider-has-no-selectable-model' };
  }
  return {
    compositeKey: `${provider}::${replacement}`,
    kind: 'select',
    reason: 'local-runtime-model-reselected',
  };
}

function resolveRegistryDecision(inputs: ModelSelectionReconcileInputs): ModelSelectionDecision {
  const next = findFirstProviderWithEnabledModels(inputs.configuredProviders, (provider) =>
    providerHasEnabledModels(inputs, provider)
  );
  if (next) {
    const model = resolveModelForProvider(inputs, next);
    if (!model) {
      return { kind: 'keep', reason: 'candidate-provider-has-no-selectable-model' };
    }
    return {
      compositeKey: `${next}::${model}`,
      kind: 'select',
      reason: 'reconciled-from-registry',
    };
  }
  if (inputs.selectedProvider) {
    return { kind: 'clear', reason: 'no-provider-has-enabled-models' };
  }
  return { kind: 'keep', reason: 'nothing-selected-and-nothing-available' };
}

/**
 * Decide what the assistant's model selection should be. Pure: the caller
 * applies `select`/`clear` against the preferences store and ignores `keep`.
 */
export function reconcileModelSelection(
  inputs: ModelSelectionReconcileInputs
): ModelSelectionDecision {
  const seeded = resolveSeedDecision(inputs);
  if (seeded) {
    return seeded;
  }

  if (shouldSkipReconcile(inputs)) {
    return { kind: 'keep', reason: 'discovery-pending' };
  }

  const provider = inputs.selectedProvider;
  if (provider && !inputs.configuredProviders.includes(provider)) {
    if (isLocalRuntimeProvider(provider)) {
      return { kind: 'keep', reason: 'local-runtime-provider-not-discovered' };
    }
    return { kind: 'clear', reason: 'provider-unavailable' };
  }

  if (provider) {
    const localRuntime = resolveLocalRuntimeDecision(inputs, provider);
    if (localRuntime) {
      return localRuntime;
    }
    if (
      providerHasEnabledModels(inputs, provider) &&
      hasValidProviderModelSelection({
        currentProvider: provider,
        currentSelectedModel: inputs.selectedModel,
        isModelEnabled: (_providerId, modelId) => isModelEnabled(inputs, modelId),
        providerModelIds: inputs.getProviderLlmModels(provider).map((model) => model.id),
      })
    ) {
      return { kind: 'keep', reason: 'selection-valid' };
    }
  }

  return resolveRegistryDecision(inputs);
}
