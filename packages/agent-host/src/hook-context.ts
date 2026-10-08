import type { ToolContent } from 'ai';
import { jsonValue } from './json-value.js';
import type { HostEvent } from './protocol.js';

type HostToolResultOutput = Extract<ToolContent[number], { type: 'tool-result' }>['output'];
type HookContextEvent = Extract<HostEvent, { type: 'hook.context' }>;

/**
 * Bound on the assistant text handed to Stop hooks: the tail, because an
 * acceptance hook grades the final answer (the legacy server's same bound).
 */
const STOP_ASSISTANT_MESSAGE_TAIL_CHARS = 64 * 1024;

/** A run's hook context: its UserPromptSubmit context and each tool result's PostToolUse context. */
export interface HostRunHookContext {
  promptContext?: string;
  readonly toolContexts: Map<string, string>;
}

/** Live acceptance and replay apply a committed hook context to its run the same way. */
export function foldHostHookContext(run: HostRunHookContext, event: HookContextEvent): void {
  if (event.toolCallId === undefined) {
    run.promptContext = event.context;
  } else {
    run.toolContexts.set(event.toolCallId, event.context);
  }
}

/** The SDK's own reading of a tool's output when the tool supplies no projection. */
export function defaultHostToolModelOutput(output: unknown): HostToolResultOutput {
  return typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: jsonValue(output) };
}

/**
 * A tool result as the model reads it, with a PostToolUse hook's context
 * beside the result. Error and denial results are left as they are.
 */
export function withHostToolHookContext(
  output: HostToolResultOutput,
  context: string | undefined
): HostToolResultOutput {
  if (!context) {
    return output;
  }
  const note = { text: `PostToolUse hook context:\n${context}`, type: 'text' as const };
  switch (output.type) {
    case 'text':
      return { type: 'content', value: [{ text: output.value, type: 'text' }, note] };
    case 'json':
      return {
        type: 'content',
        value: [{ text: JSON.stringify(output.value), type: 'text' }, note],
      };
    case 'content':
      return { type: 'content', value: [...output.value, note] };
    default:
      return output;
  }
}

/** How a run's end reads to a Stop hook. */
export function hostStopReason(
  outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome']
): 'aborted' | 'complete' | 'error' {
  if (outcome === 'completed') {
    return 'complete';
  }
  return outcome === 'failed' ? 'error' : 'aborted';
}

/** The run's own assistant text across its steps, tail-bounded, for its Stop hooks. */
export function hostRunAssistantTail(
  messages: readonly { readonly content: unknown; readonly role: string }[]
): string | undefined {
  const steps = messages.flatMap((message) => {
    if (message.role !== 'assistant') {
      return [];
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((part: { readonly text?: unknown; readonly type?: unknown }) =>
                part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
              )
              .join('')
          : '';
    return text.length > 0 ? [text] : [];
  });
  const tail = steps.join('\n').slice(-STOP_ASSISTANT_MESSAGE_TAIL_CHARS);
  return tail.length > 0 ? tail : undefined;
}
