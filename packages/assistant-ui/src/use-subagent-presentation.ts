import { use, useCallback, useEffect, useState } from 'react';
import {
  type SubagentConversationPresentation,
  SubagentConversationPresentationContext,
} from './subagent-conversation-navigation';

type Entry = {
  readonly revision: number;
  readonly threadId: string;
  readonly resolver: (threadId: string) => Promise<SubagentConversationPresentation>;
} & ({ readonly presentation: SubagentConversationPresentation } | { readonly error: string });

export function useSubagentPresentation(threadId: string | undefined) {
  const resolver = use(SubagentConversationPresentationContext);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const [entry, setEntry] = useState<Entry>();
  useEffect(() => {
    if (!(threadId && resolver)) {
      return;
    }
    let active = true;
    resolver(threadId).then(
      (presentation) => {
        if (active) {
          setEntry({ presentation, resolver, revision, threadId });
        }
      },
      (error: unknown) => {
        if (active) {
          setEntry({
            error: error instanceof Error ? error.message : String(error),
            resolver,
            revision,
            threadId,
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [threadId, resolver, revision]);
  return {
    entry:
      entry &&
      entry.threadId === threadId &&
      entry.resolver === resolver &&
      entry.revision === revision
        ? entry
        : undefined,
    reload,
  };
}
