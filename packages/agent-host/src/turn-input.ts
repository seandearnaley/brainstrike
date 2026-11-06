/**
 * A turn opens with one user message: the run's own input. ADR-0028 step 3b
 * adds user messages inside a running run, the notices it takes at a step
 * boundary, so a turn's input is told by identity, not by role. The mark rides
 * in the message's own `providerOptions`, under a namespace no provider reads,
 * so it survives the commit, every rewrite and Memory's selection.
 * https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message
 */
import type { ModelMessage, UserModelMessage } from 'ai';
import type { HostParams } from './protocol.ts';

const NAMESPACE = 'brainstrike';
const INTAKE = { [NAMESPACE]: { intake: true } };
/** A person's message an earlier run left unread, read before this turn's own message (`before`). */
const EARLIER = { [NAMESPACE]: { before: true, intake: true } };

/** The user message that carries `text`, the notices a running run takes, to its model. */
export function hostIntakeMessage(text: string): UserModelMessage {
  return {
    content: [{ text, type: 'text' }],
    providerOptions: INTAKE,
    role: 'user',
  };
}

/** Marks the text part that carries what the host read for a person's message, never shown as theirs. */
export const HOST_INPUT_CONTEXT = { [NAMESPACE]: { context: true } };

/**
 * A person's message a running run takes at a step: their words and images,
 * as a run/start's, then `context`, what their message called for (mentioned
 * files, activated skills, a hook's added context).
 */
export function hostPersonInputMessage(
  input: HostParams<'run/input'>,
  context?: string,
  earlier = false
): UserModelMessage {
  return {
    content: [
      ...(input.prompt ? [{ text: input.prompt, type: 'text' as const }] : []),
      ...(input.attachments ?? []).map(
        ({ data, mediaType }) => ({ data, mediaType, type: 'file' }) as const
      ),
      ...(context
        ? [{ providerOptions: HOST_INPUT_CONTEXT, text: context, type: 'text' as const }]
        : []),
    ],
    providerOptions: earlier ? EARLIER : INTAKE,
    role: 'user',
  };
}

/**
 * Whether `message` is a person's message an earlier run left unread (a Stop,
 * a restart), which the turn's first step read: the person wrote it before
 * the turn's own message, so the turn's context places it ahead of that.
 */
export function isHostEarlierInput(message: ModelMessage): boolean {
  return message.role === 'user' && message.providerOptions?.[NAMESPACE]?.['before'] === true;
}

/** Whether `message` opens a turn: a user message the host did not add inside a run. */
export function isHostTurnInput(message: ModelMessage): boolean {
  return message.role === 'user' && message.providerOptions?.[NAMESPACE]?.['intake'] !== true;
}
