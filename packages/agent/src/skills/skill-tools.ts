/**
 * Assistant skill tools — Mastra's canonical `createSkillTools`
 * (`skill` / `skill_search` / `skill_read`) wrapped with brainstrike's
 * tool-output contract: string results self-bound with an HONEST truncation
 * note (never a hard size error), inside the tool budgets the transport guard
 * enforces (`skill` gets the dedicated activation budget — see
 * tool-output-limits.ts). The wrapped tools are merged into the runtime's
 * local tool map BEFORE `applyToolGuards` / `applyToolHooks` / the plan-mode
 * filter / the permission gate, so — unlike Mastra's Agent-level auto-added
 * skill tools — they traverse the full pipeline like every native tool (the
 * adoption blocker recorded in docs/agents/workspace-context.md).
 */

import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { WorkspaceSkills } from '@mastra/core/skills';
import { createSkillTools } from '@mastra/core/workspace';
import {
  NATIVE_TOOL_RESULT_TOKEN_BUDGET,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';

export { SKILL_ACTIVATION_RESULT_TOKEN_BUDGET };

/** The canonical Mastra skill tool ids (never renamed/namespaced). */
export const SKILL_TOOL_IDS = ['skill', 'skill_read', 'skill_search'] as const;

/** Mirrors countTokensHeuristic (4 chars/token) — same unit as the guard. */
const APPROX_CHARS_PER_TOKEN = 4;

type AnyToolExecute = (input: unknown, context: unknown) => Promise<unknown>;

/**
 * The transport guard measures JSON-SERIALIZED length (quotes + escaped
 * newlines/quotes inflate a raw string), so self-bounding must fit the
 * SERIALIZED form under the budget or a "truncated" result would still trip
 * the backstop. Binary-search the largest content prefix whose serialized
 * `content + note` fits.
 */
function fitToSerializedBudget(content: string, note: string, maxSerializedChars: number): string {
  const fits = (candidate: string): boolean =>
    JSON.stringify(candidate + note).length <= maxSerializedChars;
  let low = 0;
  let high = content.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = sliceCodePoints(content, mid);
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best + note;
}

function withBoundedStringOutput<TTool extends object>(
  tool: TTool,
  maxTokens: number,
  buildNote: (originalChars: number) => string
): TTool {
  const originalExecute = (tool as { execute?: AnyToolExecute }).execute;
  if (!originalExecute) {
    return tool;
  }
  const maxSerializedChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const boundedExecute: AnyToolExecute = async (input, context) => {
    const output = await originalExecute(input, context);
    if (typeof output !== 'string' || JSON.stringify(output).length <= maxSerializedChars) {
      return output;
    }
    return fitToSerializedBudget(output, buildNote(output.length), maxSerializedChars);
  };
  return { ...tool, execute: boundedExecute } as TTool;
}

/**
 * Create the three skill tools over a {@link WorkspaceSkills} engine, each
 * self-bounding its string output within the transport budget.
 */
export function createAssistantSkillTools(skills: WorkspaceSkills) {
  const tools = createSkillTools(skills);
  return {
    skill: withBoundedStringOutput(
      tools.skill,
      SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Skill instructions truncated at ~${SKILL_ACTIVATION_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full activation is ${originalChars.toLocaleString()} chars). The Agent Skills spec ` +
        'recommends keeping SKILL.md under ~5000 tokens — ask the user to move detail into ' +
        'references/ files, which you can read with skill_read.]'
    ),
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_read: withBoundedStringOutput(
      tools.skill_read,
      NATIVE_TOOL_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Output truncated at ~${NATIVE_TOOL_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full file is ${originalChars.toLocaleString()} chars). ` +
        'Re-read a narrower slice with startLine/endLine.]'
    ),
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_search: withBoundedStringOutput(
      tools.skill_search,
      NATIVE_TOOL_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Results truncated at ~${NATIVE_TOOL_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full result is ${originalChars.toLocaleString()} chars). ` +
        'Narrow the query or lower topK.]'
    ),
  };
}
