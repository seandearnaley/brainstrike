import {
  BUILT_IN_PERSONAS,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '@brainstrike/assistant-contract/personas';

const PERSONA_LABELS = new Map<string, string>(
  BUILT_IN_PERSONAS.map((persona) => [persona.id, persona.label])
);

/**
 * Resolve the human label for an `agent-<id>` delegation tool name. Built-ins
 * resolve their display label; any other delegation tool (a user-defined
 * persona, whose labels are not statically known to the renderer) falls back
 * to the persona id — and a non-delegation tool name passes through raw
 * (never blank).
 */
export function personaLabelForToolName(toolName: string): string {
  if (!toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
    return toolName;
  }
  const personaId = toolName.slice(SUBAGENT_DELEGATION_TOOL_PREFIX.length);
  return PERSONA_LABELS.get(personaId) ?? personaId;
}
