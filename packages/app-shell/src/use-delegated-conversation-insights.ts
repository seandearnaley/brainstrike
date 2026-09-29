import type { DelegatedConversationUpdate } from '@brainstrike/assistant-ui';
import {
  type DelegatedConversationDatabase,
  type DelegatedConversationScope,
  readDelegatedConversationInsights,
} from '@brainstrike/db';
import { useEffect, useState } from 'react';
import type { DelegatedConversationInsightsState } from './delegated-conversation-toolbar';

export interface DelegatedConversationInsightsOptions {
  readonly db: DelegatedConversationDatabase;
  readonly node: DelegatedConversationScope & { readonly threadId: string };
  readonly update?: DelegatedConversationUpdate | undefined;
}

/** Refresh durable scope at a new leg/pause/terminal boundary, not on every text token. */
export function useDelegatedConversationInsights({
  db,
  node: { ownerResourceId, rootThreadId, threadId },
  update,
}: DelegatedConversationInsightsOptions): DelegatedConversationInsightsState {
  const readKey = JSON.stringify([
    ownerResourceId,
    rootThreadId,
    threadId,
    update?.messageId,
    update?.continuation?.nativeRunId ?? update?.identity?.childRuntimeRunId,
    update?.message.status,
  ]);
  const [loaded, setLoaded] = useState<{
    readonly db: DelegatedConversationDatabase;
    readonly key: string;
    readonly state: DelegatedConversationInsightsState;
  }>();
  useEffect(() => {
    let active = true;
    readDelegatedConversationInsights(db, { ownerResourceId, rootThreadId }, threadId).then(
      (value) => {
        if (active) {
          setLoaded({ db, key: readKey, state: { status: 'ready', value } });
        }
      },
      (cause: unknown) => {
        if (active) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          setLoaded({ db, key: readKey, state: { error, status: 'error' } });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [db, ownerResourceId, rootThreadId, threadId, readKey]);
  // A render for a new owner must not expose the previous owner's data while
  // React is waiting to clean up the old effect and start the new read.
  return loaded?.db === db && loaded.key === readKey ? loaded.state : { status: 'loading' };
}
