/**
 * Thin React binding for {@link reconcileModelSelection}.
 *
 * BST-1652: the decision lives in a pure module; this hook only supplies the
 * input snapshot and applies the result. It deliberately owns no policy — a
 * branch added here instead of in `model-selection-reconcile.ts` is a branch
 * that can only be tested by mounting the assistant panel again.
 */

import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';
import type { LlmProviderModelDefinition } from '../assistant-ui-panel-wrapper-runtime';
import {
  type AssistantProviderDiscoveryState,
  reconcileModelSelection,
} from './model-selection-reconcile';

const modelReconcileLogger = createLogger('AssistantModelReconcile');

interface UseModelSelectionReconcileArgs {
  readonly clearModel: () => void;
  readonly configuredProviders: readonly SupportedProvider[];
  readonly discoveryState: AssistantProviderDiscoveryState;
  readonly enabledModelIds: ReadonlySet<string>;
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  /** Live store read — the reconcile runs after commit, so it must not use a render snapshot. */
  readonly getSelectedModel: () => string | null;
  readonly getSelectedProvider: () => SupportedProvider | null;
  readonly setModel: (compositeKey: string) => void;
}

export function useModelSelectionReconcile({
  clearModel,
  configuredProviders,
  discoveryState,
  enabledModelIds,
  getProviderLlmModels,
  getSelectedModel,
  getSelectedProvider,
  setModel,
}: UseModelSelectionReconcileArgs): void {
  useEffect(() => {
    const decision = reconcileModelSelection({
      configuredProviders,
      discoveryState,
      enabledModelIds,
      getProviderLlmModels,
      selectedModel: getSelectedModel(),
      selectedProvider: getSelectedProvider(),
    });

    if (decision.kind === 'keep') {
      return;
    }

    // Only state CHANGES are logged: a reconcile that keeps the selection is
    // the steady state and would drown the signal. Debug level — this explains
    // an otherwise silent model swap when someone asks why the picker moved.
    if (decision.kind === 'select') {
      modelReconcileLogger.debug('Selecting assistant model', {
        model: decision.compositeKey,
        reason: decision.reason,
      });
      setModel(decision.compositeKey);
      return;
    }

    modelReconcileLogger.debug('Clearing assistant model selection', { reason: decision.reason });
    clearModel();
  }, [
    clearModel,
    configuredProviders,
    discoveryState,
    enabledModelIds,
    getProviderLlmModels,
    getSelectedModel,
    getSelectedProvider,
    setModel,
  ]);
}
