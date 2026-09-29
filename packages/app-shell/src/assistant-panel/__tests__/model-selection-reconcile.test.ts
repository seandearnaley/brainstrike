import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';
import type { LlmProviderModelDefinition } from '../../assistant-ui-panel-wrapper-runtime';
import {
  type ModelSelectionReconcileInputs,
  reconcileModelSelection,
} from '../model-selection-reconcile';

/**
 * BST-1652.
 *
 * The model reconcile used to live entirely inside a `useEffect` in
 * `assistant-ui-panel-wrapper.tsx`, calling `setModel`/`clearModel` through six
 * `useCallback` helpers. There was no way to ask "what did reconcile decide,
 * and why" — the only seam was mounting the 1,900-line wrapper and observing
 * the store afterwards, which is why every branch below was previously
 * untested. `reconcileModelSelection` is that answer as a value: one pure
 * function, one decision per branch, no React and no PGlite.
 */

function model(id: string): LlmProviderModelDefinition {
  return {
    contextWindow: 128_000,
    id,
    type: 'llm',
    vision: 'unsupported',
  };
}

const MODELS_BY_PROVIDER: Partial<
  Record<SupportedProvider, readonly LlmProviderModelDefinition[]>
> = {
  anthropic: [model('claude-x')],
  lmstudio: [model('lmstudio-a')],
  local: [],
  ollama: [model('ollama-a')],
  openai: [model('gpt-x'), model('gpt-y')],
};

function inputs(
  overrides: Partial<ModelSelectionReconcileInputs> = {}
): ModelSelectionReconcileInputs {
  return {
    configuredProviders: ['openai'],
    discoveryState: 'ready',
    enabledBuiltInLocalModelIds: [],
    enabledModelIds: new Set<string>(['gpt-x', 'gpt-y', 'claude-x']),
    getProviderLlmModels: (provider) => MODELS_BY_PROVIDER[provider] ?? [],
    renderedSelectedModel: null,
    selectedModel: null,
    selectedProvider: null,
    ...overrides,
  };
}

describe('reconcileModelSelection', () => {
  describe('built-in local seeding', () => {
    it('seeds the first downloaded built-in local model when nothing is selected', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['local', 'openai'],
            enabledBuiltInLocalModelIds: ['gemma-3'],
            enabledModelIds: new Set(['gemma-3']),
          })
        )
      ).toEqual({
        compositeKey: 'local::gemma-3',
        kind: 'select',
        reason: 'seeded-built-in-local-default',
      });
    });

    it('does not seed when a model is already selected', () => {
      const decision = reconcileModelSelection(
        inputs({
          configuredProviders: ['local', 'openai'],
          enabledBuiltInLocalModelIds: ['gemma-3'],
          enabledModelIds: new Set(['gemma-3', 'gpt-x']),
          renderedSelectedModel: 'openai::gpt-x',
          selectedModel: 'openai::gpt-x',
          selectedProvider: 'openai',
        })
      );

      expect(decision.reason).not.toBe('seeded-built-in-local-default');
    });

    it('does not seed when the built-in local provider is not configured', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            enabledBuiltInLocalModelIds: ['gemma-3'],
            enabledModelIds: new Set(['gemma-3']),
          })
        ).reason
      ).not.toBe('seeded-built-in-local-default');
    });

    it('does not seed a downloaded model the registry has not enabled', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['local'],
            enabledBuiltInLocalModelIds: ['gemma-3'],
            enabledModelIds: new Set<string>(),
          })
        ).reason
      ).not.toBe('seeded-built-in-local-default');
    });
  });

  describe('discovery gating', () => {
    it.each(['idle', 'loading'] as const)(
      'keeps the current selection while discovery is %s',
      (discoveryState) => {
        expect(
          reconcileModelSelection(
            inputs({
              discoveryState,
              renderedSelectedModel: 'openai::gpt-x',
              selectedModel: 'openai::gpt-x',
              selectedProvider: 'openai',
            })
          )
        ).toEqual({ kind: 'keep', reason: 'discovery-pending' });
      }
    );

    it('keeps the selection when discovery resolved to no providers at all', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: [],
            renderedSelectedModel: 'openai::gpt-x',
            selectedModel: 'openai::gpt-x',
            selectedProvider: 'openai',
          })
        )
      ).toEqual({ kind: 'keep', reason: 'discovery-pending' });
    });

    it('still reconciles a local-runtime selection when no providers were discovered', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: [],
            enabledModelIds: new Set(['ollama-a']),
            renderedSelectedModel: 'ollama::ollama-a',
            selectedModel: 'ollama::ollama-a',
            selectedProvider: 'ollama',
          })
        ).reason
      ).not.toBe('discovery-pending');
    });
  });

  describe('provider availability', () => {
    it('clears a selection whose provider is no longer configured', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            renderedSelectedModel: 'anthropic::claude-x',
            selectedModel: 'anthropic::claude-x',
            selectedProvider: 'anthropic',
          })
        )
      ).toEqual({ kind: 'clear', reason: 'provider-unavailable' });
    });

    it('never clears a local-runtime provider that discovery did not report', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            enabledModelIds: new Set(['gpt-x', 'lmstudio-a']),
            renderedSelectedModel: 'lmstudio::lmstudio-a',
            selectedModel: 'lmstudio::lmstudio-a',
            selectedProvider: 'lmstudio',
          })
        )
      ).toEqual({ kind: 'keep', reason: 'local-runtime-provider-not-discovered' });
    });
  });

  describe('local-runtime selection', () => {
    it('keeps a local-runtime model that is still enabled', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['ollama'],
            enabledModelIds: new Set(['ollama-a']),
            renderedSelectedModel: 'ollama::ollama-a',
            selectedModel: 'ollama::ollama-a',
            selectedProvider: 'ollama',
          })
        )
      ).toEqual({ kind: 'keep', reason: 'local-runtime-selection-valid' });
    });

    it('re-picks a local-runtime model when the selected one vanished from the catalog', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['ollama'],
            enabledModelIds: new Set(['ollama-a']),
            renderedSelectedModel: 'ollama::retired',
            selectedModel: 'ollama::retired',
            selectedProvider: 'ollama',
          })
        )
      ).toEqual({
        compositeKey: 'ollama::ollama-a',
        kind: 'select',
        reason: 'local-runtime-model-reselected',
      });
    });

    it('falls through to the general reconcile when the local runtime has no models left', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['ollama', 'openai'],
            enabledModelIds: new Set(['gpt-x']),
            renderedSelectedModel: 'ollama::retired',
            selectedModel: 'ollama::retired',
            selectedProvider: 'ollama',
          })
        )
      ).toEqual({
        compositeKey: 'openai::gpt-x',
        kind: 'select',
        reason: 'reconciled-from-registry',
      });
    });
  });

  describe('general reconcile', () => {
    it('keeps a valid selection on a provider that still has enabled models', () => {
      expect(
        reconcileModelSelection(
          inputs({
            renderedSelectedModel: 'openai::gpt-x',
            selectedModel: 'openai::gpt-x',
            selectedProvider: 'openai',
          })
        )
      ).toEqual({ kind: 'keep', reason: 'selection-valid' });
    });

    it('re-selects from the registry when the selected model was disabled', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            enabledModelIds: new Set(['gpt-y']),
            renderedSelectedModel: 'openai::gpt-x',
            selectedModel: 'openai::gpt-x',
            selectedProvider: 'openai',
          })
        )
      ).toEqual({
        compositeKey: 'openai::gpt-y',
        kind: 'select',
        reason: 'reconciled-from-registry',
      });
    });

    it('selects the first configured provider that has enabled models when nothing is selected', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['anthropic', 'openai'],
            enabledModelIds: new Set(['claude-x']),
          })
        )
      ).toEqual({
        compositeKey: 'anthropic::claude-x',
        kind: 'select',
        reason: 'reconciled-from-registry',
      });
    });

    it('clears the selection when no configured provider has an enabled model', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            enabledModelIds: new Set<string>(),
            renderedSelectedModel: 'openai::gpt-x',
            selectedModel: 'openai::gpt-x',
            selectedProvider: 'openai',
          })
        )
      ).toEqual({ kind: 'clear', reason: 'no-provider-has-enabled-models' });
    });

    it('does nothing when nothing is selected and nothing is available', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['openai'],
            enabledModelIds: new Set<string>(),
          })
        )
      ).toEqual({ kind: 'keep', reason: 'nothing-selected-and-nothing-available' });
    });

    /**
     * The built-in local provider advertises no catalog entries, so
     * `providerHasEnabledModels` accepts it on the strength of a DOWNLOADED
     * model id while `resolveProviderModelSelection` (catalog-only) returns
     * nothing. This is the one place the two predicates could disagree, and the
     * `?? enabledBuiltInLocalModelIds[0]` fallback is what keeps them in step —
     * which is also why `candidate-provider-has-no-selectable-model` stays
     * unreachable. Pin the fallback so the guard never becomes live silently.
     */
    it('falls back to a downloaded built-in local model when its catalog is empty', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['local'],
            enabledBuiltInLocalModelIds: ['gemma-3'],
            enabledModelIds: new Set<string>(),
            renderedSelectedModel: 'local::retired',
            selectedModel: 'local::retired',
            selectedProvider: 'local',
          })
        )
      ).toEqual({
        compositeKey: 'local::gemma-3',
        kind: 'select',
        reason: 'reconciled-from-registry',
      });
    });
  });

  describe('render-vs-live selection snapshots', () => {
    // The seed branch reads the RENDER-captured `selectedModel` while the rest
    // of the reconcile reads the live store; the extraction preserves that
    // divergence rather than quietly changing it. Pinned so a future
    // simplification is a deliberate choice, not an accident.
    it('gates seeding on the rendered snapshot, not the live one', () => {
      expect(
        reconcileModelSelection(
          inputs({
            configuredProviders: ['local'],
            enabledBuiltInLocalModelIds: ['gemma-3'],
            enabledModelIds: new Set(['gemma-3']),
            renderedSelectedModel: null,
            selectedModel: 'local::gemma-3',
            selectedProvider: 'local',
          })
        )
      ).toEqual({
        compositeKey: 'local::gemma-3',
        kind: 'select',
        reason: 'seeded-built-in-local-default',
      });
    });
  });
});
