import { type ToolCallMessagePartComponent, useAuiState } from '@assistant-ui/react';
import {
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
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
