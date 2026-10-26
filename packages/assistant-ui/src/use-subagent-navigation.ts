import { type MouseEvent, use, useState } from 'react';
import {
  type SubagentConversationAddress,
  SubagentConversationNavigationContext,
  SubagentInvocationResolverContext,
  type SubagentInvocationRun,
} from './subagent-conversation-navigation';

export function useSubagentNavigation(
  address: SubagentConversationAddress,
  invocation: SubagentInvocationRun,
  toolCallId: string
) {
  const open = use(SubagentConversationNavigationContext);
  const resolve = use(SubagentInvocationResolverContext);
  const [navigationError, setNavigationError] = useState<string>();
  if (address.kind === 'invalid') {
    return { navigationError: address.error };
  }
  if (invocation.kind === 'invalid') {
    return { navigationError: invocation.error };
  }
  if (!open) {
    return {};
  }
  const fail = (error: unknown): void =>
    setNavigationError(error instanceof Error ? error.message : String(error));
  if (address.kind === 'available') {
    return {
      ...(navigationError ? { navigationError } : {}),
      onOpenConversation: (event: MouseEvent<HTMLButtonElement>) => {
        setNavigationError(undefined);
        open(address.threadId, event.currentTarget).catch(fail);
      },
    };
  }
  if (!(resolve && invocation.kind === 'available')) {
    return {};
  }
  return {
    ...(navigationError ? { navigationError } : {}),
    onOpenConversation: (event: MouseEvent<HTMLButtonElement>) => {
      const origin = event.currentTarget;
      setNavigationError(undefined);
      resolve({
        parentRuntimeRunId: invocation.parentRuntimeRunId,
        parentToolCallId: toolCallId,
      })
        .then((threadId) => open(threadId, origin))
        .catch(fail);
    },
  };
}
