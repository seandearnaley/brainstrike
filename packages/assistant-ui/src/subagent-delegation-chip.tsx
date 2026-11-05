import type { MouseEvent, ReactElement } from 'react';
import { use } from 'react';
import { SubagentChip } from './subagent-chip';
import { SubagentConversationNavigationContext } from './subagent-conversation-navigation';
import { useSubagentDelegationAddress } from './subagent-tool-cards';
import { useSubagentPresentation } from './use-subagent-presentation';

/**
 * The subagent a delegation call started, as a chip in its family colour that
 * opens its conversation; nothing until the child conversation is known.
 */
export function SubagentDelegationChip({
  result,
  toolCallId,
}: {
  readonly result: unknown;
  readonly toolCallId: string;
}): ReactElement | null {
  const { address } = useSubagentDelegationAddress(toolCallId, result);
  const threadId = address.kind === 'available' ? address.threadId : undefined;
  const { entry } = useSubagentPresentation(threadId);
  const open = use(SubagentConversationNavigationContext);
  if (!(threadId && entry && 'presentation' in entry)) {
    return null;
  }
  const { colorId, displayName } = entry.presentation;
  return (
    <SubagentChip
      agent={{
        callSign: displayName,
        ...(colorId ? { colorId } : {}),
        ...(open
          ? {
              onOpen: (event: MouseEvent<HTMLButtonElement>) => open(threadId, event.currentTarget),
            }
          : {}),
      }}
    />
  );
}
