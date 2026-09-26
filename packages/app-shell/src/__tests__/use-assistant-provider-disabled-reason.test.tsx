import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useAssistantProviderDisabledReason } from '../hooks/use-assistant-provider-disabled-reason';

const base = {
  configuredProviders: ['ollama'] as const,
  currentModel: 'ollama::private-model',
  getProviderLlmModels: () => [],
  localRuntimeHint: undefined,
  providerHasEnabledModels: () => true,
  selectedProvider: 'ollama' as const,
};
let records: LogRecord[];
let unsubscribe: () => void;
beforeEach(() => {
  configureLogger({ console: false });
  records = [];
  unsubscribe = addLogListener((record) => {
    if (record.message === 'assistant_model_unavailable_shown') {
      records.push(record);
    }
  });
});
afterEach(() => {
  unsubscribe();
  resetLogger();
});
function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}
it('reports one visible local-model notice per transition without its model name', () => {
  const { result, rerender } = renderHook(
    ({ hidden }) => useAssistantProviderDisabledReason(base, hidden),
    { initialProps: { hidden: false }, wrapper }
  );
  expect(result.current).toContain('unavailable');
  expect(records).toHaveLength(1);
  rerender({ hidden: false });
  expect(records).toHaveLength(1);
  rerender({ hidden: true });
  expect(records).toHaveLength(1);
  rerender({ hidden: false });
  expect(records).toHaveLength(2);
  expect(records[0]?.args).toContainEqual({
    code: 'assistant_model_unavailable_shown',
    provider: 'ollama',
    schemaVersion: 1,
  });
  expect(JSON.stringify(records)).not.toContain('private-model');
});
it('does not report a local warning hidden by a higher-priority notice', () => {
  renderHook(() => useAssistantProviderDisabledReason(base, true));
  expect(records).toEqual([]);
});
it('does not report hosted providers as unavailable local models', () => {
  renderHook(() =>
    useAssistantProviderDisabledReason({ ...base, selectedProvider: 'openai' }, false)
  );
  expect(records).toEqual([]);
});
