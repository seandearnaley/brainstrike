import type { InputProcessor, ProcessInputArgs } from '@mastra/core/processors';
import type { AgentMessage } from '../types';

export type DelegatedSystemContext = ProcessInputArgs['systemMessages'];
export type DelegatedSystemContextSource = () => DelegatedSystemContext;
const CONTEXT_TAG = 'brainstrike-delegated-workspace';
export const MAX_DELEGATED_CONTEXT_BYTES = 64 * 1024;

/** Only host-supplied system messages enter this boundary, never the generated
 * supervisor instructions or model-authored delegation parameters. */
export function captureDelegatedSystemContext(
  messages: readonly AgentMessage[]
): DelegatedSystemContext {
  const context: DelegatedSystemContext = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      continue;
    }
    const text: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'text') {
        throw new Error('Delegated system context must contain only text.');
      }
      text.push(part.text);
    }
    context.push({ content: text.join('\n\n'), role: 'system' });
  }
  return context;
}

/** Store context on the child's native MessageList before it can suspend.
 * Mastra snapshots tagged system messages; a fresh approval runtime must use
 * that original snapshot, not reread potentially changed workspace files. */
export function createDelegatedSystemContextProcessor(
  getContext: DelegatedSystemContextSource
): InputProcessor {
  return {
    id: CONTEXT_TAG,
    processInput({ messageList }) {
      const context = getContext();
      if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_DELEGATED_CONTEXT_BYTES) {
        throw new Error('Trusted delegated context exceeds its 64 KiB budget.');
      }
      messageList.addSystem(context, CONTEXT_TAG);
      return messageList;
    },
  };
}
