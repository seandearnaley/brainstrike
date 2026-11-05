/**
 * A turn opens with one user message: the run's own input. ADR-0028 step 3b
 * adds user messages inside a running run, the notices it takes at a step
 * boundary, so a turn's input is told by identity, not by role. The mark rides
 * in the message's own `providerOptions`, under a namespace no provider reads,
 * so it survives the commit, every rewrite and Memory's selection.
 * https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message
 */
import type { ModelMessage, UserModelMessage } from 'ai';

const NAMESPACE = 'brainstrike';

/** The user message that carries `text`, the notices a running run takes, to its model. */
export function hostIntakeMessage(text: string): UserModelMessage {
  return {
    content: [{ text, type: 'text' }],
    providerOptions: { [NAMESPACE]: { intake: true } },
    role: 'user',
  };
}

/** Whether `message` opens a turn: a user message the host did not add inside a run. */
export function isHostTurnInput(message: ModelMessage): boolean {
  return message.role === 'user' && message.providerOptions?.[NAMESPACE]?.['intake'] !== true;
}
