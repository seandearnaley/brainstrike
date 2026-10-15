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
  ollama: [model('ollama-a')],
  openai: [model('gpt-x'), model('gpt-y')],
};

function inputs(
  overrides: Partial<ModelSelectionReconcileInputs> = {}
): ModelSelectionReconcileInputs {
  return {
    configuredProviders: ['openai'],
    discoveryState: 'ready',
    enabledModelIds: new Set<string>(['gpt-x', 'gpt-y', 'claude-x']),
    getProviderLlmModels: (provider) => MODELS_BY_PROVIDER[provider] ?? [],
    selectedModel: null,
    selectedProvider: null,
    ...overrides,
  };
}

describe('reconcileModelSelection', () => {
  describe('discovery gating', () => {
    it.each(['idle', 'loading'] as const)(
      'keeps the current selection while discovery is %s',
      (discoveryState) => {
        expect(
          reconcileModelSelection(
            inputs({
              discoveryState,
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
  });
});
