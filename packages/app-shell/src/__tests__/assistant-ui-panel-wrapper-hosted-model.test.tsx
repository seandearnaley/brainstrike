import './assistant-ui-panel-wrapper-test-support';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { fileExplorerMocks, renderAssistantPanel } from './assistant-ui-panel-wrapper-test-support';

// Web has no `window.agentHost`, so it has no durable memory backend. That
// costs the turn its memory block, not its composer: before the browser-local
// provider was retired it was the only provider that satisfied
// `resolveHostedMemoryBackendAvailable` on web, so treating the absence as a
// block left web unable to send with any provider at all.
test('keeps hosted web chat sendable without a workspace, and says memory is off', async () => {
  Reflect.deleteProperty(window, 'agentHost');
  fileExplorerMocks.rootDirectoryHandle = null;

  await renderAssistantPanel(['openai'], () =>
    waitFor(() => {
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
      expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
        'Assistant memory is unavailable here; this turn runs without durable memory.'
      );
    })
  );
});

test('reconciles an active thread draft to the hosted fixed model', async () => {
  useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
    model: 'gpt-5.2',
    provider: 'openai',
    providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
  });

  render(
    <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
      <AssistantUiPanelWrapper
        fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
        memoryResourceId="/tmp/test-workspace"
        memoryThreadId="thread-existing"
      />
    </AssistantProviderSourceProvider>
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
    <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
      <AssistantUiPanelWrapper
        fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
        memoryResourceId="/tmp/test-workspace"
        memoryThreadId="thread-existing"
      />
    </AssistantProviderSourceProvider>
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

test('rebuilds stale draft options when the hosted fixed model already matches', async () => {
  useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
    model: 'gpt-5.6-terra',
    provider: 'openai',
    providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
  });

  render(
    <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
      <AssistantUiPanelWrapper
        fixedProviderModels={{ openai: ['gpt-5.6-terra'] }}
        memoryResourceId="/tmp/test-workspace"
        memoryThreadId="thread-existing"
      />
    </AssistantProviderSourceProvider>
  );

  await waitFor(() => {
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']
    ).not.toHaveProperty('providerOptions.openrouter');
  });
});
