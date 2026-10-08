import type { OpenRouterModelMetadataLookup, RuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantProviderSettings } from '@brainstrike/types';
import { useEffect, useMemo, useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import {
  buildAgentLoopSettings,
  buildEffectiveModelSettings,
  resolveOpenRouterMetadataDisabledReason,
  type SelectedModelBudgetDef,
} from '../assistant-ui-panel-wrapper-runtime';

const MAX_VISIBLE_ERROR_CHARS = 300;

/**
 * Stable identity for the in-flight lookup. Rebuilding this literal per render
 * changed `lookup`'s identity every render, which invalidated every downstream
 * `useMemo` that depends on it.
 */
const LOADING_LOOKUP: OpenRouterModelMetadataLookup = { state: 'loading' };

function toVisibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'OpenRouter metadata request failed';
  return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
}

interface OpenRouterMetadataBudgetModel extends SelectedModelBudgetDef {
  readonly id: string;
}

interface UseOpenRouterModelMetadataOptions {
  readonly modelId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly providerId: string | null | undefined;
  readonly selectedModelDef: OpenRouterMetadataBudgetModel | undefined;
  readonly settings: AssistantProviderSettings | undefined;
}

interface UseOpenRouterModelMetadataResult {
  readonly agentLoopSettings: RuntimeData['agentLoop'] | undefined;
  readonly lookup: OpenRouterModelMetadataLookup | undefined;
  readonly modelDef: SelectedModelBudgetDef | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly reason: string | undefined;
}

export function useOpenRouterModelMetadata({
  modelId,
  modelSettings,
  providerId,
  selectedModelDef,
  settings,
}: UseOpenRouterModelMetadataOptions): UseOpenRouterModelMetadataResult {
  // Only a host answers model metadata; web has no lookup and keeps the catalog.
  const readOpenRouterModel = useAssistantThreadHost()?.providers?.readOpenRouterModel;
  const requestKey =
    providerId === 'openrouter' && modelId && readOpenRouterModel
      ? `openrouter:${modelId}`
      : undefined;
  const [result, setResult] = useState<{
    readonly lookup: OpenRouterModelMetadataLookup;
    readonly requestKey: string;
  }>();

  useEffect(() => {
    if (!(requestKey && modelId && readOpenRouterModel)) {
      return;
    }

    const controller = new AbortController();
    readOpenRouterModel(modelId)
      .then((snapshot) => {
        if (snapshot.metadata.id !== modelId) {
          throw new Error(
            `OpenRouter model metadata returned "${snapshot.metadata.id}" for expected model "${modelId}".`
          );
        }
        return snapshot;
      })
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setResult({ lookup: { snapshot, state: 'resolved' }, requestKey });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            lookup: { message: toVisibleError(error), state: 'error' },
            requestKey,
          });
        }
      });

    return () => controller.abort();
  }, [modelId, readOpenRouterModel, requestKey]);

  const lookup: OpenRouterModelMetadataLookup | undefined = requestKey
    ? result?.requestKey === requestKey
      ? result.lookup
      : LOADING_LOOKUP
    : undefined;
  const budgetModelDef = useMemo<SelectedModelBudgetDef | undefined>(() => {
    if (!(selectedModelDef && lookup?.state === 'resolved')) {
      return selectedModelDef;
    }
    const metadata = lookup.snapshot.metadata;
    if (metadata.id !== selectedModelDef.id) {
      return selectedModelDef;
    }
    return {
      contextWindow: metadata.contextWindow,
      ...(metadata.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: metadata.maxOutputTokens }),
    };
  }, [lookup, selectedModelDef]);
  const disabledReason = useMemo(
    () => resolveOpenRouterMetadataDisabledReason(providerId, settings, lookup, modelSettings),
    [lookup, modelSettings, providerId, settings]
  );
  const effectiveModelSettings = useMemo(
    () =>
      disabledReason
        ? modelSettings
        : buildEffectiveModelSettings(
            providerId,
            modelSettings,
            budgetModelDef,
            lookup?.state === 'resolved' ? lookup.snapshot.metadata : undefined,
            modelId,
            settings?.reasoningEffort || undefined
          ),
    [budgetModelDef, disabledReason, lookup, modelId, modelSettings, providerId, settings]
  );
  const agentLoopSettings = useMemo(
    () =>
      disabledReason
        ? undefined
        : buildAgentLoopSettings(settings, budgetModelDef, providerId, effectiveModelSettings),
    [budgetModelDef, disabledReason, effectiveModelSettings, providerId, settings]
  );
  return {
    agentLoopSettings,
    lookup,
    modelDef: budgetModelDef,
    modelSettings: effectiveModelSettings,
    reason: disabledReason,
  };
}
