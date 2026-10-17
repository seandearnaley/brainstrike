/**
 * One web thread on the shared log (BST-1940): the shared committed
 * conversation (`@brainstrike/host-conversation`) over the browser host
 * client, rendered as desktop renders a host thread. Its runs start, stream
 * and stop through the client, which records them from the proxy.
 */
import { CommittedAssistantConversation } from '@brainstrike/assistant-ui';
import {
  type CommittedHostThread,
  createCommittedHostThread,
} from '@brainstrike/host-conversation';
import type { WebHostClient } from '@brainstrike/web-writer/web-host-client';
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';

export interface WebHostThreadProps {
  readonly client: WebHostClient;
  readonly onRunningChange?: ((threadId: string, running: boolean) => void) | undefined;
  /** The hosted provider the next run asks for; Hosted Web chooses its model on the server. */
  readonly readModelId: () => string;
  readonly threadId: string;
}

/**
 * The view's committed thread, owned from commit to cleanup: a render replay
 * never starts a second subscription, and the view reads the owned thread as
 * an external store rather than setting state from its effect.
 */
class OwnedThread {
  #thread: CommittedHostThread | undefined;
  readonly #listeners = new Set<() => void>();

  readonly get = (): CommittedHostThread | undefined => this.#thread;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Owns `thread` until the returned release, which closes it. */
  own(thread: CommittedHostThread): () => void {
    this.#publish(thread);
    return () => {
      thread.close();
      if (this.#thread === thread) {
        this.#publish(undefined);
      }
    };
  }

  #publish(thread: CommittedHostThread | undefined): void {
    this.#thread = thread;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export function WebHostThread({
  client,
  onRunningChange,
  readModelId,
  threadId,
}: WebHostThreadProps): ReactElement {
  const [owned] = useState(() => new OwnedThread());
  const thread = useSyncExternalStore(owned.subscribe, owned.get, owned.get);
  useEffect(() => {
    // Commit-time view ownership survives StrictMode render replay without
    // starting duplicate subscriptions or disposing a still-mounted source.
    const current = createCommittedHostThread({
      client,
      runSettings: () => ({ modelId: readModelId() }),
      threadId,
    });
    current.connect();
    return owned.own(current);
  }, [client, owned, readModelId, threadId]);
  return thread ? (
    <CommittedAssistantConversation
      commands={thread.commands}
      label="Assistant"
      onRunningChange={onRunningChange}
      store={thread.store}
    />
  ) : (
    <div role="status">Opening the thread…</div>
  );
}
