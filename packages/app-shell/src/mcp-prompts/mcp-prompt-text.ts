/**
 * Pure text projection for MCP prompt selection (BST-1592).
 *
 * A `prompts/get` result is a list of ROLE-tagged messages whose content may be
 * text, image, audio, or an embedded resource. The composer draft is plain
 * text, so only text parts can be staged there. Everything that cannot be
 * represented is REPORTED (`omitted`) rather than dropped: the caller surfaces
 * it to the user, so a prompt is never silently truncated into something the
 * server did not author.
 *
 * Nothing here sends: the expansion is written into the composer draft and the
 * user reads, edits, and sends it — the same contract as user-defined
 * `/commands` and Agent Skills.
 */
import type { McpHostOperationResult } from '@brainstrike/assistant-contract';

type GetPromptResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>['result'];
type PromptMessage = GetPromptResult['messages'][number];

export interface McpPromptInsertion {
  /** Human-readable descriptions of message parts that could not be staged. */
  readonly omitted: readonly string[];
  /** The staged draft text; empty when the prompt carried no text at all. */
  readonly text: string;
}

/** Where the typed `/trigger` sat in the draft, captured before the library strips it. */
export interface ComposerTriggerSplit {
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * The LAST `/mcp:<partial>` token in the draft — the trigger as it stands when
 * the popover matched by fuzzy search before the id was fully typed.
 */
const PARTIAL_TRIGGER_PATTERN = /\/mcp:\S*(?!.*\/mcp:)/u;

function describeOmitted(message: PromptMessage, index: number): string {
  return `message ${index + 1} (${message.role}): ${message.content.type} content`;
}

/**
 * Build the draft text for one `prompts/get` result.
 *
 * A single user text message stages verbatim — the overwhelmingly common shape,
 * and adding chrome around it would put words in the server's mouth. Anything
 * else (multiple messages, or an assistant turn) is role-labelled, because a
 * multi-turn prompt collapsed into one anonymous blob misrepresents what the
 * server returned.
 */
export function buildMcpPromptInsertion(result: GetPromptResult): McpPromptInsertion {
  const omitted: string[] = [];
  const parts: { readonly role: string; readonly text: string }[] = [];
  result.messages.forEach((message, index) => {
    if (message.content.type === 'text') {
      parts.push({ role: message.role, text: message.content.text });
      return;
    }
    omitted.push(describeOmitted(message, index));
  });
  const labelled = parts.length > 1 || parts.some((part) => part.role !== 'user');
  const text = labelled
    ? parts.map((part) => `[${part.role}]\n${part.text}`).join('\n\n')
    : (parts[0]?.text ?? '');
  return { omitted, text };
}

/**
 * Split the live draft around the typed slash trigger, preserving everything
 * the user wrote before and after it. The popover can be invoked mid-draft, so
 * consuming to end-of-string would silently delete trailing words.
 *
 * The trigger may be the full `/${commandId}` token or the partial prefix that
 * was typed when the popover matched by fuzzy search; with neither present the
 * insertion appends to the draft.
 */
export function splitComposerTrigger(draftText: string, commandId: string): ComposerTriggerSplit {
  const fullTrigger = `/${commandId}`;
  const fullIndex = draftText.lastIndexOf(fullTrigger);
  if (fullIndex >= 0) {
    return {
      prefix: draftText.slice(0, fullIndex),
      suffix: draftText.slice(fullIndex + fullTrigger.length),
    };
  }
  const partialMatch = PARTIAL_TRIGGER_PATTERN.exec(draftText);
  if (partialMatch) {
    return {
      prefix: draftText.slice(0, partialMatch.index),
      suffix: draftText.slice(partialMatch.index + partialMatch[0].length),
    };
  }
  return { prefix: draftText, suffix: '' };
}

/**
 * Splice staged prompt text back into the captured draft, keeping exactly one
 * space between the surrounding words so a mid-draft insertion does not weld
 * itself onto the previous token.
 */
export function applyComposerTriggerSplit(split: ComposerTriggerSplit, text: string): string {
  const prefix =
    split.prefix.length > 0 && !/\s$/u.test(split.prefix) ? `${split.prefix} ` : split.prefix;
  const suffix =
    split.suffix.length > 0 && !/^\s/u.test(split.suffix) ? ` ${split.suffix}` : split.suffix;
  return `${prefix}${text}${suffix}`;
}
