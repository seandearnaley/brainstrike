import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
} from '@brainstrike/assistant-contract/personas';
import { SubagentExecutionCard } from './subagent-execution-card';

/**
 * `agent-<personaId>` delegation tool name → SubagentExecutionCard, generated
 * from the built-in personas. Spread into the panel's tool `by_name` map so each
 * delegation tool part renders as a collapsed subagent card instead of a raw
 * tool card. assistant-ui's `by_name` matches exact tool names (no regex), so
 * every registered persona needs its own key — this keeps that data-driven.
 */
export const SUBAGENT_TOOL_CARDS: Record<string, ToolCallMessagePartComponent> = Object.fromEntries(
  BUILT_IN_PERSONAS.map((persona) => [
    delegationToolNameForPersona(persona.id),
    SubagentExecutionCard,
  ])
);
