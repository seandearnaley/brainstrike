import './assistant-ui-panel-wrapper-test-support';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { act, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, test } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import type { DelegatedConversationRoot } from '../delegated-conversation-owner';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { STREAMING_NOTIFY_WINDOW_MS } from '../delegated-conversation-store';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';
import { delegatedPanelCallbacks } from './assistant-ui-panel-wrapper-test-support';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

function DelegatedRootProbe() {
  const root = useDelegatedConversationRoot('/tmp/test-workspace', 'thread-existing');
  return root ? <SubscribedRootProbe root={root} /> : null;
}

function SubscribedRootProbe({ root }: { readonly root: DelegatedConversationRoot }) {
  const snapshots = useSyncExternalStore(root.store.subscribe, root.store.getSnapshot);
  const selection = useSyncExternalStore(
    root.modelSelection.subscribe,
    root.modelSelection.getState
  );
  return (
    <div data-model={selection.selectedModel} data-testid="delegated-root-probe">
      {JSON.stringify([...snapshots.values()].map((snapshot) => snapshot.update.message.parts))}
    </div>
  );
}

describe('panel delegation wiring', () => {
  test('connects the actual panel stream and runtime to its owning workspace root', async () => {
    useAssistantPreferencesStore.getState().setModel('openai::gpt-5.2');
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    render(
      <DelegatedConversationRootsProvider>
        <AssistantProviderSourceProvider
          source={{ kind: 'authoritative', providers: ['openai', 'anthropic'] }}
        >
          <AssistantUiPanelWrapper
            memoryResourceId="/tmp/test-workspace"
            memoryThreadId="thread-existing"
            providerKeySources={[
              { provider: 'openai', source: 'stored' },
              { provider: 'anthropic', source: 'stored' },
            ]}
          />
          <DelegatedRootProbe />
        </AssistantProviderSourceProvider>
      </DelegatedConversationRootsProvider>
    );
    await screen.findByTestId('assistant-ui-panel');
    expect(screen.getByTestId('delegated-root-probe')).toHaveAttribute(
      'data-model',
      'anthropic::claude-sonnet-4-6'
    );
    await act(async () => {
      useAssistantThreadStore
        .getState()
        .setThreadDraftRuntime('thread-existing', { model: 'gpt-5.2', provider: 'openai' });
    });
    expect(screen.getByTestId('delegated-root-probe')).toHaveAttribute(
      'data-model',
      'openai::gpt-5.2'
    );
    expect(delegatedPanelCallbacks.onRuntimeReady).toBeTypeOf('function');
    await act(async () => {
      delegatedPanelCallbacks.onDelegatedConversation?.(
        delegatedUpdate('child', 'initial', 'Live child evidence')
      );
      // A RUNNING child's publications notify once per coalescing window
      // (`delegated-conversation-store.ts`), so the probe sees it a frame later.
      await new Promise((resolve) => setTimeout(resolve, STREAMING_NOTIFY_WINDOW_MS + 1));
    });
    expect(screen.getByTestId('delegated-root-probe')).toHaveTextContent('Live child evidence');
  });
});
