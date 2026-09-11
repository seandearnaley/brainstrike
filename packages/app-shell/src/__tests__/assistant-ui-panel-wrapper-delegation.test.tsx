import './assistant-ui-panel-wrapper-test-support';
import { act, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, test } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { useDelegatedConversationRoot } from '../use-delegated-conversation-root';
import { delegatedPanelCallbacks } from './assistant-ui-panel-wrapper-test-support';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

function DelegatedRootProbe() {
  const root = useDelegatedConversationRoot('/tmp/test-workspace', 'thread-existing');
  if (!root) {
    throw new Error('Missing root provider');
  }
  const snapshots = useSyncExternalStore(root.store.subscribe, root.store.getSnapshot);
  return (
    <div data-testid="delegated-root-probe">
      {JSON.stringify([...snapshots.values()].map((snapshot) => snapshot.update.message.parts))}
    </div>
  );
}

describe('panel delegation wiring', () => {
  test('connects the actual panel stream and runtime to its owning workspace root', async () => {
    render(
      <DelegatedConversationRootsProvider>
        <AssistantProviderSourceProvider source={{ kind: 'authoritative', providers: ['openai'] }}>
          <AssistantUiPanelWrapper
            memoryResourceId="/tmp/test-workspace"
            memoryThreadId="thread-existing"
            providerKeySources={[{ provider: 'openai', source: 'stored' }]}
          />
          <DelegatedRootProbe />
        </AssistantProviderSourceProvider>
      </DelegatedConversationRootsProvider>
    );
    await screen.findByTestId('assistant-ui-panel');
    expect(delegatedPanelCallbacks.onRuntimeReady).toBeTypeOf('function');
    await act(async () => {
      delegatedPanelCallbacks.onDelegatedConversation?.(
        delegatedUpdate('child', 'initial', 'Live child evidence')
      );
    });
    expect(screen.getByTestId('delegated-root-probe')).toHaveTextContent('Live child evidence');
  });
});
