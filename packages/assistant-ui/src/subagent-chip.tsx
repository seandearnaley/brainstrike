import type { MouseEvent, ReactElement } from 'react';
import { agentColorStyle } from './agent-color-style';

/** A subagent named by its call sign in its family colour. */
export interface SubagentChipAgent {
  readonly callSign: string;
  /** Its durable family colour; absent while the host has not listed it yet. */
  readonly colorId?: string;
  /** Opens its conversation; absent where it cannot be opened from here. */
  readonly onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * A subagent's call sign on a dot of its family colour. With `onOpen` it is a
 * button that opens the subagent's conversation.
 */
export function SubagentChip({ agent }: { readonly agent: SubagentChipAgent }): ReactElement {
  const content = (
    <>
      <span aria-hidden="true" className="bs-subagent-chip-dot" />
      <span className="bs-subagent-chip-label">{agent.callSign}</span>
    </>
  );
  const shared = {
    className: 'bs-subagent-chip',
    'data-agent-color': agent.colorId ?? 'unresolved',
    'data-testid': 'subagent-chip',
    style: agentColorStyle(agent.colorId),
  } as const;
  return agent.onOpen ? (
    <button
      {...shared}
      aria-label={`Go to ${agent.callSign}`}
      onClick={agent.onOpen}
      title={`Open ${agent.callSign}'s conversation`}
      type="button"
    >
      {content}
    </button>
  ) : (
    // The title names a chip folded to its dot (`.bs-activity-agents`).
    <span {...shared} title={agent.callSign}>
      {content}
    </span>
  );
}
