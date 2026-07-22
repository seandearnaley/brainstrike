import type { OpenRouterModelMetadataLookup, RuntimeData } from '@brainstrike/assistant-contract';
import type { AssistantProviderSettings } from '@brainstrike/types';
import { useEffect, useMemo, useState } from 'react';
import {
  resolveOpenRouterMetadataDisabledReason,
  type SelectedModelBudgetDef,
} from '../assistant-ui-panel-wrapper-runtime';
import { fetchOpenRouterModelMetadata } from '../openrouter-model-metadata-client';
import { hasDesktopAssistantBridge } from '../use-steer-active-run';
import { resolveAssistantAuthHeaders, resolveAssistantBaseUrl } from './use-assistant-availability';

const MAX_VISIBLE_ERROR_CHARS = 300;

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
  readonly lookup: OpenRouterModelMetadataLookup | undefined;
  readonly modelDef: SelectedModelBudgetDef | undefined;
  readonly reason: string | undefined;
}

export function useOpenRouterModelMetadata({
  modelId,
  modelSettings,
  providerId,
  selectedModelDef,
  settings,
}: UseOpenRouterModelMetadataOptions): UseOpenRouterModelMetadataResult {
  const requestKey =
    providerId === 'openrouter' && modelId && hasDesktopAssistantBridge()
      ? `openrouter:${modelId}`
      : undefined;
  const [result, setResult] = useState<{
    readonly lookup: OpenRouterModelMetadataLookup;
    readonly requestKey: string;
  }>();

  useEffect(() => {
    if (!(requestKey && modelId)) {
      return;
    }

    const controller = new AbortController();
    void Promise.all([resolveAssistantBaseUrl(), resolveAssistantAuthHeaders()])
      .then(([baseUrl, authHeaders]) =>
        fetchOpenRouterModelMetadata({
          authHeaders,
          baseUrl,
          modelId,
          signal: controller.signal,
        })
      )
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
  }, [modelId, requestKey]);

  const lookup: OpenRouterModelMetadataLookup | undefined = requestKey
    ? result?.requestKey === requestKey
      ? result.lookup
      : { state: 'loading' }
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
  return { lookup, modelDef: budgetModelDef, reason: disabledReason };
}
