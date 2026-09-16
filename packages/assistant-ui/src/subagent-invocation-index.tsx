import { useAui } from '@assistant-ui/react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { SubagentInvocationIndexContext } from './subagent-invocation-index-context';
import { createSubagentInvocationIndex } from './subagent-invocation-index-model';

interface ThreadStateReader {
  getState(): {
    readonly messages: readonly {
      readonly id: string;
      readonly parts: readonly unknown[];
      readonly status?: unknown;
    }[];
  };
}

function readRuntimeMessages(thread: ThreadStateReader) {
  return thread.getState().messages.map((message) => ({
    id: message.id,
    parts: message.parts,
    status: message.status,
  }));
}

export function SubagentInvocationIndexProvider({ children }: { readonly children: ReactNode }) {
  const aui = useAui();
  const thread = aui.thread();
  const index = useMemo(() => {
    const next = createSubagentInvocationIndex();
    next.advance(readRuntimeMessages(thread));
    return next;
  }, [thread]);

  useEffect(() => {
    const unsubscribe = aui.subscribe(() => index.advance(readRuntimeMessages(thread)));
    // Subscribe before rereading to close the render-to-effect update gap.
    index.advance(readRuntimeMessages(thread));
    return unsubscribe;
  }, [aui, index, thread]);

  return (
    <SubagentInvocationIndexContext.Provider value={index}>
      {children}
    </SubagentInvocationIndexContext.Provider>
  );
}
