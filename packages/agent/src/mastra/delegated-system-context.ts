import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor, ProcessInputArgs } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { AgentMessage } from '../types';

export type DelegatedSystemContext = ProcessInputArgs['systemMessages'];
export type DelegatedSystemContextSource = () => DelegatedSystemContext;
const ROOT_CONTEXT_KEY = 'brainstrike.delegated-system-context.v1';
const ROOT_THREAD_KEY = 'brainstrike.delegated-root-thread.v1';
const contextSchema = z.array(z.object({ content: z.string(), role: z.literal('system') }));
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
        // The root converter excludes non-text metadata from system authority too.
        continue;
      }
      const trimmed = part.text.trim();
      if (trimmed) {
        text.push(trimmed);
      }
    }
    if (text.length > 0) {
      context.push({ content: text.join('\n\n'), role: 'system' });
    }
  }
  return context;
}

/** Persist only host-projected system data in the native root RequestContext.
 * Native workflow snapshots restore this data for approval and question resumes,
 * including new delegations started after the root continues. No callbacks,
 * RuntimeData, tool results or execution capabilities cross this boundary. */
export function createRootDelegatedContextProcessor(
  getContext: DelegatedSystemContextSource | undefined,
  enabled: boolean
): InputProcessor | undefined {
  if (!enabled) {
    return undefined;
  }
  return {
    id: ROOT_CONTEXT_KEY,
    processInputStep({ messageList, requestContext }) {
      if (getContext) {
        if (!requestContext) {
          throw new Error('Trusted delegated context requires native request context.');
        }
        requestContext.set(ROOT_CONTEXT_KEY, contextSchema.parse(getContext()));
        const rootMemory = parseMemoryRequestContext(requestContext);
        if (rootMemory?.thread) {
          requestContext.set(ROOT_THREAD_KEY, rootMemory.thread.id);
        }
      }
      return messageList;
    },
  };
}

/** Store context on the child's native MessageList before it can suspend.
 * Mastra snapshots tagged system messages; a fresh approval runtime must use
 * that original snapshot, not reread potentially changed workspace files. */
export function createDelegatedSystemContextProcessor(
  getContext?: DelegatedSystemContextSource
): InputProcessor {
  return {
    id: CONTEXT_TAG,
    processInput({ messageList, requestContext }) {
      const stored = requestContext?.get(ROOT_CONTEXT_KEY);
      if (stored === undefined && !getContext) {
        throw new Error(
          'Trusted delegated context is missing from this snapshot. Start a new parent turn.'
        );
      }
      const context =
        stored === undefined && getContext ? getContext() : contextSchema.parse(stored);
      if (Buffer.byteLength(JSON.stringify(context), 'utf8') > MAX_DELEGATED_CONTEXT_BYTES) {
        throw new Error('Trusted delegated context exceeds its 64 KiB budget.');
      }
      messageList.addSystem(context, CONTEXT_TAG);
      return messageList;
    },
  };
}

/** Native child history may restore without the caller repeating root memory.
 * The root snapshot identity prevents child discovery from borrowing root history. */
export function readDelegatedHistoryScope(
  requestContext: RequestContext | undefined,
  rootThreadId: string | undefined
): { readonly resourceId: string; readonly threadId: string } | undefined {
  const child = parseMemoryRequestContext(requestContext);
  if (!child?.thread) {
    return;
  }
  const root = rootThreadId ?? z.string().min(1).parse(requestContext?.get(ROOT_THREAD_KEY));
  if (child.thread.id === root) {
    return;
  }
  if (!child.resourceId) {
    throw new Error('Worker discovery requires native child resource identity.');
  }
  return { resourceId: child.resourceId, threadId: child.thread.id };
}
