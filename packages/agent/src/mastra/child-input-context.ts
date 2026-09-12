import type { InputProcessor } from '@mastra/core/processors';
import { z } from 'zod';
import { MAX_DELEGATED_CONTEXT_BYTES } from './delegated-system-context';

export const CHILD_INPUT_CONTEXT_KEY = 'brainstrikeChildInputContext';
export const childInputContextSchema = z.array(
  z.object({ content: z.string(), role: z.literal('system') })
);
export type ChildInputSystemContext = z.output<typeof childInputContextSchema>;
export type PrepareChildInputContext = () => Promise<ChildInputSystemContext>;

/** Authenticated host context is stored separately from the user's text/file parts. */
export function validateChildInputContext(value: unknown): ChildInputSystemContext {
  const context = childInputContextSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_DELEGATED_CONTEXT_BYTES) {
    throw new Error('Child input context exceeds its 64 KiB budget.');
  }
  return context;
}

/** Only native user signals can carry this host field; ordinary user metadata is not authority. */
export function createChildInputContextProcessor(): InputProcessor {
  return {
    id: CHILD_INPUT_CONTEXT_KEY,
    processInputStep({ messageList }) {
      const messages = messageList.get.all.db();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'signal') {
          continue;
        }
        const signal = message.content.metadata?.['signal'];
        if (!signal || typeof signal !== 'object' || Reflect.get(signal, 'type') !== 'user') {
          continue;
        }
        const metadata: unknown = Reflect.get(signal, 'metadata');
        const context =
          metadata &&
          typeof metadata === 'object' &&
          Object.hasOwn(metadata, CHILD_INPUT_CONTEXT_KEY)
            ? validateChildInputContext(Reflect.get(metadata, CHILD_INPUT_CONTEXT_KEY))
            : [];
        // A native user input owns this tag even when it carries no context.
        // addSystem appends, so replace only our tag before applying this input.
        messageList.clearSystemMessages(CHILD_INPUT_CONTEXT_KEY);
        messageList.addSystem(context, CHILD_INPUT_CONTEXT_KEY);
        break;
      }
      return messageList;
    },
  };
}
