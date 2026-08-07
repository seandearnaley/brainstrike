import { type ToolCallMessagePartComponent, useAuiState } from '@assistant-ui/react';
import {
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '@brainstrike/assistant-contract/personas';
import { createElement, useMemo } from 'react';
import { SubagentExecutionCard } from './subagent-execution-card';
import { type SubAgentToolRow, serializeLiveSubagentToolRows } from './subagent-tool-rows';

/**
 * The registered delegation-tool component: reads the current message's parts
 * from the assistant-ui store, derives this delegation's LIVE `subagent.tool.*`
 * rows (matched by `parentToolCallId`), and threads them to the presentational
 * SubagentExecutionCard so a running delegation shows in-progress child tools
 * before the result (with `subAgentToolResults`) lands. Kept out of the card so
 * the card stays render-testable without the assistant-ui store.
 *
 * The selector serializes the derived rows (see `serializeLiveSubagentToolRows`):
 * `useAuiState` compares selector results with `Object.is`, so returning the raw
 * `state.message.parts` array — a stable reference that grows in place — would
 * never re-render, freezing the live count on an early snapshot (D2).
 */
const SubagentExecutionCardConnected: ToolCallMessagePartComponent = (props) => {
  const liveRowsJson = useAuiState((state) =>
    serializeLiveSubagentToolRows(state.message.parts, props.toolCallId)
  );
  const liveRows = useMemo(() => JSON.parse(liveRowsJson) as SubAgentToolRow[], [liveRowsJson]);
  return createElement(SubagentExecutionCard, {
    liveRows,
    result: props.result,
    status: props.status,
    toolCallId: props.toolCallId,
    toolName: props.toolName,
  });
};

/**
 * `agent-<personaId>` delegation tool name → SubagentExecutionCardConnected,
 * generated from the built-in personas. Spread into the panel's tool `by_name`
 * map so each delegation tool part renders as a collapsed subagent card instead
 * of a raw tool card. assistant-ui's `by_name` matches exact tool names (no
 * regex), so every registered persona needs its own key — this keeps that
 * data-driven.
 */
export const SUBAGENT_TOOL_CARDS: Record<string, ToolCallMessagePartComponent> = Object.fromEntries(
  BUILT_IN_PERSONAS.map((persona) => [
    delegationToolNameForPersona(persona.id),
    SubagentExecutionCardConnected,
  ])
);

/**
 * Whether a tool name is a Mastra delegation tool (`agent-<personaId>`).
 * assistant-ui's `by_name` map is exact-match, so USER-DEFINED personas (whose
 * ids are not statically known) cannot be pre-registered — the panel's
 * Fallback uses this predicate to route any delegation part to the
 * SubagentExecutionCard instead of a raw tool card. Mastra reserves the
 * `agent-` prefix for delegation tools; native tools are `brainstrike.*` and
 * MCP tools are namespaced by server, so the prefix cannot collide.
 */
export function isSubagentDelegationToolName(toolName: string | undefined): boolean {
  // The Fallback can render parts with no toolName (e.g. non-tool chain
  // steps); those are never delegation cards.
  return toolName?.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX) === true;
}

/** The connected delegation card, exported for the Fallback router. */
export const SubagentDelegationCard: ToolCallMessagePartComponent = SubagentExecutionCardConnected;
