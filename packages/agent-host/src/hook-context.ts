import type { ToolContent } from 'ai';
import type { HostRunState } from './core-state.js';
import { jsonValue } from './json-value.js';
import type { HostRunAdmission } from './ports.js';
import type { HostEvent } from './protocol.js';

type HostToolResultOutput = Extract<ToolContent[number], { type: 'tool-result' }>['output'];
type HookContextEvent = Extract<HostEvent, { type: 'hook.context' }>;
type RunFinishedEvent = Extract<HostEvent, { type: 'run.finished' }>;

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
function hostStopReason(outcome: RunFinishedEvent['outcome']): 'aborted' | 'complete' | 'error' {
  if (outcome === 'completed') {
    return 'complete';
  }
  return outcome === 'failed' ? 'error' : 'aborted';
}

/** The run's own assistant text across its steps, tail-bounded, for its Stop hooks. */
function hostRunAssistantTail(
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

/** Live and replayed hook context rows apply to their committed run. */
export function foldHostHookContextEvent(
  runs: ReadonlyMap<string, HostRunState>,
  event: HookContextEvent
): void {
  const run = runs.get(event.runId);
  if (!run) {
    throw new Error('Hook context references an unknown run');
  }
  foldHostHookContext(run, event);
}

/**
 * A run's terminal rows: its Stop hooks see how it ended, and a verdict they
 * report labels the run in the same append as `run.finished`, never after it.
 */
export async function hostRunTerminalEvents(
  run: HostRunState,
  finished: RunFinishedEvent
): Promise<HostEvent[]> {
  const hooks = run.admission?.hooks;
  if (!hooks) {
    return [finished];
  }
  const assistantMessage = hostRunAssistantTail(run.messages);
  const { verdict } = await hooks.stop({
    ...(assistantMessage === undefined ? {} : { assistantMessage }),
    reason: hostStopReason(finished.outcome),
  });
  if (!verdict) {
    return [finished];
  }
  const label: HostEvent = {
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    runId: run.id,
    source: 'hook',
    type: 'run.verdict',
    verdict: verdict.verdict,
  };
  return [label, finished];
}

/**
 * A fresh run's prompt passes its UserPromptSubmit hooks before the first
 * step. Added context is committed, so recovery keeps it, and joins the run's
 * instructions. Returns why the run must fail instead: a block, with the
 * hook's reason, or a failed gate.
 */
export async function passHostPromptHooks(
  run: HostRunState,
  admission: HostRunAdmission,
  commit: (events: HostEvent[]) => Promise<unknown>
): Promise<string | undefined> {
  try {
    const gate = await admission.hooks?.userPromptSubmit(run.branch.prompt);
    if (gate?.blocked) {
      return `The request was blocked by a hook: ${gate.reason}`;
    }
    if (gate?.additionalContext) {
      await commit([{ context: gate.additionalContext, runId: run.id, type: 'hook.context' }]);
    }
    return;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
