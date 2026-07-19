import './assistant-ui-panel-wrapper-test-support';
import { render, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { loadTestLocalLlmBackend } from './assistant-ui-panel-wrapper-test-support';

test('reconciles an active thread draft to the hosted fixed model', async () => {
  useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
    model: 'gpt-5.2',
    provider: 'openai',
    providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
  });

  render(
    <AssistantUiPanelWrapper
      fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
      initialProviders={['openai']}
      loadLocalLlmBackend={loadTestLocalLlmBackend}
      memoryResourceId="/tmp/test-workspace"
      memoryThreadId="thread-existing"
    />
  );

  await waitFor(() => {
    const draft = useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing'];
    expect(draft).toMatchObject({
      model: 'gpt-5.6-terra',
      provider: 'openai',
    });
    expect(draft).not.toHaveProperty('providerOptions.openrouter');
  });
});

test('reconciles an unavailable thread draft provider to the hosted provider', async () => {
  useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
    model: 'claude-sonnet-4.6',
    provider: 'anthropic',
  });

  render(
    <AssistantUiPanelWrapper
      fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
      initialProviders={['openai']}
      loadLocalLlmBackend={loadTestLocalLlmBackend}
      memoryResourceId="/tmp/test-workspace"
      memoryThreadId="thread-existing"
    />
  );

  await waitFor(() => {
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']
    ).toMatchObject({
      model: 'gpt-5.6-terra',
      provider: 'openai',
    });
  });
});
