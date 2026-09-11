import { use, useEffect, useState } from 'react';
import {
  type SubagentConversationPresentation,
  SubagentConversationPresentationContext,
} from './subagent-conversation-navigation';

type Entry = {
  readonly threadId: string;
  readonly resolver: (threadId: string) => Promise<SubagentConversationPresentation>;
} & ({ readonly presentation: SubagentConversationPresentation } | { readonly error: string });

export function useSubagentPresentation(threadId: string | undefined) {
  const resolver = use(SubagentConversationPresentationContext);
  const [entry, setEntry] = useState<Entry>();
  useEffect(() => {
    if (!(threadId && resolver)) {
      return;
    }
    let active = true;
    resolver(threadId).then(
      (presentation) => {
        if (active) {
          setEntry({ presentation, resolver, threadId });
        }
      },
      (error: unknown) => {
        if (active) {
          setEntry({
            error: error instanceof Error ? error.message : String(error),
            resolver,
            threadId,
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [threadId, resolver]);
  return entry?.threadId === threadId && entry?.resolver === resolver ? entry : undefined;
}
