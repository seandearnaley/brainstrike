import { type MouseEvent, use } from 'react';
import {
  type SubagentConversationAddress,
  SubagentConversationNavigationContext,
  type SubagentInvocationRun,
} from './subagent-conversation-navigation';

export function useSubagentNavigation(
  address: SubagentConversationAddress,
  invocation: SubagentInvocationRun
) {
  const open = use(SubagentConversationNavigationContext);
  if (address.kind === 'invalid') {
    return { navigationError: address.error };
  }
  if (invocation.kind === 'invalid') {
    return { navigationError: invocation.error };
  }
  if (!open) {
    return {};
  }
  if (address.kind === 'available') {
    return {
      onOpenConversation: (event: MouseEvent<HTMLButtonElement>) =>
        open(address.threadId, event.currentTarget),
    };
  }
  return {};
}
