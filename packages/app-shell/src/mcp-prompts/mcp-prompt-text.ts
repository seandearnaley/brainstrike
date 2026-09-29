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
 * Every whitespace-delimited `/token` in the draft, in order.
 *
 * The pinned popover's `matchesQuery` is a SUBSTRING test over the command id,
 * label, and description, so the typed token is not necessarily a prefix of the
 * chosen id: typing `/echo` can match `mcp:legacy:echo_reference`. Anchoring the
 * partial match on a literal `/mcp:` therefore missed the token the user
 * actually typed and left it in the staged draft. A generic `/token` covers both
 * shapes, and the leading-boundary group keeps a URL path (`https://host/x`)
 * from being mistaken for a trigger.
 *
 * `g` + `matchAll` rather than a lookahead: `.` never matches `\n`, so a
 * `(?!.*…)` "no later trigger" lookahead only ever rejected a later trigger on
 * the SAME line and a multi-line draft split around the wrong one.
 */
const TRIGGER_TOKEN_PATTERN = /(?:^|\s)(\/\S*)/gu;

/** The LAST `/token` in the draft, or `null` when the draft carries none. */
function findLastTriggerToken(draftText: string): { index: number; text: string } | null {
  let last: { index: number; text: string } | null = null;
  for (const match of draftText.matchAll(TRIGGER_TOKEN_PATTERN)) {
    const token = match[1];
    if (token === undefined) {
      continue;
    }
    last = { index: match.index + match[0].length - token.length, text: token };
  }
  return last;
}

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
 * The trigger may be the full `/${commandId}` token or — because the popover
 * matches by SUBSTRING, not by prefix — whatever `/token` the user actually
 * typed; with neither present the insertion appends to the draft.
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
  const token = findLastTriggerToken(draftText);
  if (token) {
    return {
      prefix: draftText.slice(0, token.index),
      suffix: draftText.slice(token.index + token.text.length),
    };
  }
  return { prefix: draftText, suffix: '' };
}

/**
 * Whether the live draft is still the one `split` was computed against.
 *
 * `prompts/get` is a round trip and the composer stays editable throughout, so
 * by the time the result lands the user may have typed more, or sent and
 * started a fresh draft. Replacing the draft with the SELECTION-time split would
 * silently discard that text, so the caller reconciles first and appends
 * instead of replacing whenever this returns `false`.
 *
 * Two texts count as untouched because which one is live depends only on
 * whether React has flushed the popover's own strip, never on the user:
 * the draft as it stood when the prompt was picked (the trigger still in it),
 * and the draft the pinned popover leaves behind — it applies
 * `setText(before + (after.startsWith(' ') ? after.slice(1) : after))` before it
 * calls `execute`, and the app records that through an effect.
 */
export function isComposerDraftUntouched(
  captured: { readonly draftText: string; readonly split: ComposerTriggerSplit },
  liveDraftText: string
): boolean {
  if (liveDraftText === captured.draftText) {
    return true;
  }
  const { prefix, suffix } = captured.split;
  if (liveDraftText === `${prefix}${suffix}`) {
    return true;
  }
  return suffix.startsWith(' ') && liveDraftText === `${prefix}${suffix.slice(1)}`;
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
