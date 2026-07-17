/**
 * Explicit skill activation at the request boundary (`:skill[name]`).
 *
 * The composer's "/" menu stages a VISIBLE `:skill[name]` directive (the user
 * can edit or delete it before sending — no silent expansion); here the server
 * resolves each directive in the turn's user message against the per-request
 * skills engine and PREPENDS one `system` context message carrying the
 * activations. The payload is Mastra's `formatSkillActivation` output —
 * byte-identical to what the model-initiated `skill` tool returns, so both
 * activation paths teach the model the same thing.
 *
 * Mirrors the `@file` referenced-files injector: only the LAST user message is
 * scanned, an unresolvable skill surfaces an explicit note (never a silent
 * drop), and both the per-skill and per-message budgets truncate/omit
 * HONESTLY. Directives beyond {@link MAX_ACTIVATED_SKILLS_PER_MESSAGE} and
 * activations past the aggregate budget are named in an omission note.
 */

import type { AgentMessage, WorkspaceSkills } from '@brainstrike/agent';
import { formatSkillActivation, SKILL_ACTIVATION_RESULT_TOKEN_BUDGET } from '@brainstrike/agent';
import {
  extractSkillDirectives,
  MAX_ACTIVATED_SKILLS_PER_MESSAGE,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';

const logger = createLogger('AssistantSkillActivation');

/**
 * Per-skill activation cap — the SAME budget the `skill` tool self-bounds to
 * (4 chars/token), so an explicit activation and a tool activation truncate at
 * the same point.
 */
export const MAX_SKILL_ACTIVATION_CHARS_PER_SKILL = SKILL_ACTIVATION_RESULT_TOKEN_BUDGET * 4;

/**
 * Aggregate ceiling on injected activation content per message (mirrors the
 * referenced-files / workspace-instructions 48K aggregate discipline).
 */
export const MAX_SKILL_ACTIVATION_TOTAL_CHARS = 48_000;

function extractText(message: AgentMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function findLastUserMessageIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

/**
 * Resolve any `:skill[name]` directives in the current turn's user message and
 * prepend one `system` activation message. Returns the original array (same
 * identity) when there is nothing to do — no engine (skills off ⇒ directives
 * stay inert text), no user message, or no directives.
 */
export async function injectActivatedSkillsContext(
  messages: AgentMessage[],
  workspaceSkills: WorkspaceSkills | undefined
): Promise<AgentMessage[]> {
  if (!workspaceSkills) {
    return messages;
  }
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex < 0) {
    return messages;
  }
  const lastUser = messages[lastUserIndex];
  if (!lastUser) {
    return messages;
  }
  const names = extractSkillDirectives(extractText(lastUser));
  if (names.length === 0) {
    return messages;
  }

  const sections: string[] = [
    'The user explicitly activated the following Agent Skills for this turn. Follow each activated skill’s instructions where relevant.',
  ];
  const withinCap = names.slice(0, MAX_ACTIVATED_SKILLS_PER_MESSAGE);
  const omitted: string[] = names.slice(MAX_ACTIVATED_SKILLS_PER_MESSAGE);
  let injectedChars = 0;

  for (const name of withinCap) {
    const skill = await workspaceSkills.get(name);
    if (!skill) {
      logger.warn('Activated skill is not available', { name });
      sections.push(
        `### ${name}\n[Skill "${name}" was requested but is not available (not installed, invalid, or disabled) — proceeding without it.]`
      );
      continue;
    }
    let activation = formatSkillActivation(skill);
    let suffix = '';
    if (activation.length > MAX_SKILL_ACTIVATION_CHARS_PER_SKILL) {
      activation = sliceCodePoints(activation, MAX_SKILL_ACTIVATION_CHARS_PER_SKILL);
      suffix = `\n[Truncated to the first ${MAX_SKILL_ACTIVATION_CHARS_PER_SKILL.toLocaleString()} characters — the full skill exceeds the activation budget.]`;
    }
    const section = `### Skill: ${skill.name}\n${activation}${suffix}`;
    // HARD aggregate ceiling: an activation that would overshoot is OMITTED
    // (named in the note below), never partially crammed in — the total
    // injected content can never exceed the budget.
    if (injectedChars + section.length > MAX_SKILL_ACTIVATION_TOTAL_CHARS) {
      omitted.push(name);
      continue;
    }
    injectedChars += section.length;
    sections.push(section);
  }

  if (omitted.length > 0) {
    logger.warn('Skill activations omitted (per-message cap or context budget)', {
      cap: MAX_ACTIVATED_SKILLS_PER_MESSAGE,
      omitted,
    });
    sections.push(
      `[${omitted.length} skill activation(s) omitted (per-message cap ${MAX_ACTIVATED_SKILLS_PER_MESSAGE} / context budget): ${omitted.join(', ')}. Activate them with the skill tool if needed.]`
    );
  }

  return [
    {
      id: `skill-activations-${Date.now()}`,
      parts: [{ text: sections.join('\n\n'), type: 'text' }],
      role: 'system',
    },
    ...messages,
  ];
}
