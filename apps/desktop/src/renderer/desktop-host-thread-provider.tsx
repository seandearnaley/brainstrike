import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { CommittedAssistantConversation } from '@brainstrike/assistant-ui';
import { type ReactElement, type ReactNode, useEffect, useMemo } from 'react';
import { connectDesktopAgentHost } from './agent-host-client';
import { createCommittedHostConversation } from './committed-host-conversation';

function HostThread({
  client,
  threadId,
}: {
  readonly client: HostClient;
  readonly threadId: string;
}): ReactElement {
  const conversation = useMemo(
    () =>
      createCommittedHostConversation({
        client,
        modelId: '',
        readModelId: () => {
          const model = useAssistantPreferencesStore.getState().selectedModel;
          if (!model) {
            throw new Error('Select a provider and model before sending');
          }
          return model;
        },
        threadId,
      }),
    [client, threadId]
  );
  useEffect(() => () => conversation.close(), [conversation]);
  return (
    <CommittedAssistantConversation
      commands={conversation.commands}
      label="Assistant"
      store={conversation.store}
    />
  );
}

/** Standard New Thread uses the committed host; existing history keeps its original panel. */
export function DesktopHostThreadProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const capability = useMemo<AssistantThreadHostCapability & { close(): Promise<void> }>(() => {
    let connecting: Promise<HostClient> | undefined;
    let closing: Promise<void> | undefined;
    const threads = new Map<string, HostClient>();
    const client = (): Promise<HostClient> => {
      if (closing) {
        return Promise.reject(new Error('The desktop host view is closing'));
      }
      connecting ??= connectDesktopAgentHost();
      return connecting;
    };
    return {
      close: (): Promise<void> => {
        if (!connecting) {
          return Promise.resolve();
        }
        const admitted = connecting;
        closing ??= (async () => {
          const [result] = await Promise.allSettled([admitted]);
          if (result?.status === 'fulfilled') {
            await result.value.close();
            await result.value.closed;
          }
          threads.clear();
        })();
        return closing;
      },
      createThread: async (resourceId) => {
        const host = await client();
        const { threadId } = await host.request('thread/start', { commandId: crypto.randomUUID() });
        const { rows } = await host.request('thread/read', { fromSeq: 0, threadId });
        const started = rows.find((row) => row.event.type === 'thread.started');
        if (started?.ts === undefined) {
          throw new Error('Host thread has no committed creation timestamp');
        }
        threads.set(threadId, host);
        return {
          createdAt: new Date(started.ts),
          id: threadId,
          resourceId,
          title: 'New thread',
          updatedAt: new Date(started.ts),
        };
      },
      renderThread: (threadId) => {
        const host = threads.get(threadId);
        return host ? <HostThread client={host} threadId={threadId} /> : undefined;
      },
    };
  }, []);
  useEffect(() => {
    const retire = (): void => {
      void capability.close();
    };
    window.addEventListener('beforeunload', retire, { once: true });
    return () => {
      window.removeEventListener('beforeunload', retire);
      retire();
    };
  }, [capability]);
  return (
    <AssistantThreadHostContext.Provider value={capability}>
      {children}
    </AssistantThreadHostContext.Provider>
  );
}
