import { recordAssistantModelDiagnostic } from '@brainstrike/app-state/local-runtime-diagnostics';
import { useEffect, useMemo, useRef } from 'react';
import { resolveAssistantProviderDisabledNotice } from '../assistant-ui-panel-wrapper-runtime';

/** Shares the rendered notice's priority and logs only a newly presented local warning. */
export function useAssistantProviderDisabledReason(
  {
    configuredProviders,
    currentModel,
    getProviderLlmModels,
    localRuntimeHint,
    providerHasEnabledModels,
    providerReadErrors,
    selectedProvider,
  }: Parameters<typeof resolveAssistantProviderDisabledNotice>[0],
  noticeHidden: boolean
): string | undefined {
  const notice = useMemo(
    () =>
      resolveAssistantProviderDisabledNotice({
        configuredProviders,
        currentModel,
        getProviderLlmModels,
        localRuntimeHint,
        providerHasEnabledModels,
        ...(providerReadErrors ? { providerReadErrors } : {}),
        selectedProvider,
      }),
    [
      configuredProviders,
      currentModel,
      getProviderLlmModels,
      localRuntimeHint,
      providerHasEnabledModels,
      providerReadErrors,
      selectedProvider,
    ]
  );
  const lastNotice = useRef<string | null>(null);
  useEffect(() => {
    if (
      noticeHidden ||
      notice?.kind !== 'model-unavailable' ||
      !currentModel ||
      (selectedProvider !== 'ollama' && selectedProvider !== 'lmstudio')
    ) {
      lastNotice.current = null;
      return;
    }
    const identity = JSON.stringify([selectedProvider, currentModel]);
    if (lastNotice.current === identity) {
      return;
    }
    lastNotice.current = identity;
    recordAssistantModelDiagnostic('assistant_model_unavailable_shown', selectedProvider);
  }, [currentModel, noticeHidden, notice?.kind, selectedProvider]);
  return notice?.message;
}
