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

import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { WorkspaceSkills } from '@mastra/core/skills';
import { createSkillTools } from '@mastra/core/workspace';
import type { z } from 'zod';
import { sanitizeToolName } from '../tool-projection/tool-sanitizer';
import {
  NATIVE_TOOL_RESULT_TOKEN_BUDGET,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
} from '../stream/tool-output-limits';

export { SKILL_ACTIVATION_RESULT_TOKEN_BUDGET };

/** The canonical Mastra skill tool ids (never renamed/namespaced). */
export const SKILL_TOOL_IDS = ['skill', 'skill_read', 'skill_search'] as const;

/**
 * Appended to every skill activation result. Names the skill-script runner by
 * its MODEL-FACING id (`brainstrike_runSkillScript`, never the dotted canonical
 * id: `sanitizeTools` rewrites `id` too, and `load_tool` matches exactly —
 * review of #3049). Natives are sanitized before any MCP tool joins the map,
 * so the sanitizer's base form IS the registered name; a hash suffix only ever
 * lands on a later colliding registrant.
 *
 * The runner is a DEFERRED tool on hosted discovery runs, so the guidance must
 * carry its own recovery path: without the load_tool clause, a model that
 * checks its visible tools concludes the tool does not exist and works around
 * via executeCommand, bypassing the typed skill-script policy layer (field
 * failure 2026-08-23). On non-discovery runs the tool is eager and the clause
 * is inert.
 */
const RUN_SKILL_SCRIPT_MODEL_NAME = sanitizeToolName(
  NATIVE_TOOL_REGISTRIES.nativeToolId.runSkillScript
);
const WRITE_WORKSPACE_FILE_MODEL_NAME = sanitizeToolName(
  NATIVE_TOOL_REGISTRIES.nativeToolId.writeWorkspaceFile
);

export const BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE = `\n\nBrainstrike execution: run listed skill scripts with ${RUN_SKILL_SCRIPT_MODEL_NAME} using literal args and mounted root/cwd — if that tool is not currently loaded, load it with load_tool using that exact name when available (it becomes callable on your next step in this same response — keep going and call it). Use ${WRITE_WORKSPACE_FILE_MODEL_NAME} for project writes; never construct shell heredocs. If the tool cannot be loaded or a script is declined, continue with native workspace tools and do not retry.`;

/** Mirrors countTokensHeuristic (4 chars/token) — same unit as the guard. */
const APPROX_CHARS_PER_TOKEN = 4;

type AnyToolExecute = (input: unknown, context: unknown) => Promise<unknown>;

/**
 * Override Mastra's own description/schema with the provider contract the
 * skill tool's `defineNativeTool` declaration carries (`providerDescription`
 * + `inputSchema`), so the wire schema and the settings inspector share one
 * source.
 */
function withProviderContract<TTool extends object>(
  tool: TTool,
  definition: { readonly inputSchema: z.ZodType; readonly providerDescription: string }
): TTool {
  return {
    ...tool,
    description: definition.providerDescription,
    inputSchema: definition.inputSchema,
  } as TTool;
}

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
 * Bound the activation AND append the execution guidance, in that order.
 *
 * Review of #2625: nesting `withBoundedStringOutput(withActivationGuidance(…))`
 * appended the guidance BEFORE bounding, and `fitToSerializedBudget` keeps a
 * PREFIX — so any activation exceeding the budget lost the entire trailing
 * guidance block, which is precisely the large, script-heavy SKILL.md most
 * likely to need the `runSkillScript` recovery path. The bound now reserves
 * the guidance's space: truncated content + honest note + guidance, all inside
 * the budget — the same order the desktop activation context uses
 * (`skills-activation-context.ts`: truncate first, then concatenate).
 */
function withBoundedActivationAndGuidance<TTool extends object>(
  tool: TTool,
  maxTokens: number,
  buildNote: (originalChars: number) => string
): TTool {
  const originalExecute = (tool as { execute?: AnyToolExecute }).execute;
  if (!originalExecute) {
    return tool;
  }
  const maxSerializedChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const execute: AnyToolExecute = async (input, context) => {
    const output = await originalExecute(input, context);
    if (typeof output !== 'string') {
      return output;
    }
    const withGuidance = output + BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE;
    if (JSON.stringify(withGuidance).length <= maxSerializedChars) {
      return withGuidance;
    }
    return fitToSerializedBudget(
      output,
      buildNote(output.length) + BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE,
      maxSerializedChars
    );
  };
  return { ...tool, execute } as TTool;
}

/**
 * Create the three skill tools over a {@link WorkspaceSkills} engine, each
 * self-bounding its string output within the transport budget.
 */
export function createAssistantSkillTools(skills: WorkspaceSkills) {
  const tools = createSkillTools(skills);
  return {
    skill: withBoundedActivationAndGuidance(
      withProviderContract(tools.skill, NATIVE_TOOL_REGISTRIES.byId.skill),
      SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Skill instructions truncated at ~${SKILL_ACTIVATION_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full activation is ${originalChars.toLocaleString()} chars). The Agent Skills spec ` +
        'recommends keeping SKILL.md under ~5000 tokens — ask the user to move detail into ' +
        'references/ files, which you can read with skill_read.]'
    ),
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_read: withBoundedStringOutput(
      withProviderContract(tools.skill_read, NATIVE_TOOL_REGISTRIES.byId.skill_read),
      NATIVE_TOOL_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Output truncated at ~${NATIVE_TOOL_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full file is ${originalChars.toLocaleString()} chars). ` +
        'Re-read a narrower slice with startLine/endLine.]'
    ),
    // biome-ignore lint/style/useNamingConvention: Mastra's canonical skill tool id.
    skill_search: withBoundedStringOutput(
      withProviderContract(tools.skill_search, NATIVE_TOOL_REGISTRIES.byId.skill_search),
      NATIVE_TOOL_RESULT_TOKEN_BUDGET,
      (originalChars) =>
        `\n\n[Results truncated at ~${NATIVE_TOOL_RESULT_TOKEN_BUDGET} tokens ` +
        `(the full result is ${originalChars.toLocaleString()} chars). ` +
        'Narrow the query or lower topK.]'
    ),
  };
}
