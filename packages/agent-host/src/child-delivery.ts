/**
 * BST-1932: what a parent's model reads about its background children. The
 * wording is the shipped wake ledger (packages/agent/src/mastra/
 * background-ledger.ts, removed with BST-1935); the outcomes replace their
 * dispatch acknowledgements in the parent's own tool results.
 */
import type { ModelMessage } from 'ai';
import type { HostChildDeliveryEntry } from './protocol.js';

export type HostChildLedgerState = HostChildDeliveryEntry['state'] | 'running';

export interface HostChildLedgerEntry {
  readonly persona: string;
  readonly prompt: string;
  readonly reason?: string | undefined;
  readonly state: HostChildLedgerState;
  readonly toolCallId: string;
  readonly toolName: string;
}

function describeEntry(entry: HostChildLedgerEntry): string {
  const head = `- ${entry.toolCallId} (${entry.toolName}, ${entry.persona})`;
  const prompt = ` Prompt: "${entry.prompt}".`;
  switch (entry.state) {
    case 'returned':
      return `${head}: returned.${prompt} Use its saved outcome; do not execute it again.`;
    case 'failed':
      return `${head}: failed — ${entry.reason ?? 'no reason recorded'}.${prompt} Its failure is in the conversation. Do not retry it unless the user asks.`;
    case 'cancelled':
      return `${head}: cancelled by the user; it has no result.${prompt} Do not call it again unless the user asks.`;
    case 'running':
      return `${head}: still running.${prompt} Its outcome will be delivered when it finishes.`;
    default: {
      const exhaustive: never = entry.state;
      throw new Error(`Unknown ledger state: ${String(exhaustive)}`);
    }
  }
}

/** The whole ledger of the turn's background invocations (ADR-0010), not one line per event. */
export function describeHostChildLedger(entries: readonly HostChildLedgerEntry[]): string {
  const count = (state: HostChildLedgerState): number =>
    entries.filter((entry) => entry.state === state).length;
  const running = count('running');
  const lines = [
    `Background invocations of this turn — ${entries.length} total: ${count('returned')} returned, ${count('failed')} failed, ${count('cancelled')} cancelled, ${running} still running.`,
    ...entries.map(describeEntry),
  ];
  lines.push(
    running === 0
      ? `All ${entries.length} background invocations have finished. Nothing is still running. Continue with the task using the saved outcomes.`
      : 'Do not re-dispatch a running invocation; its outcome will be delivered.'
  );
  return lines.join('\n');
}

/**
 * A completed follow-up typed into an idle child reaches its parent as the
 * shipped continuation notification (packages/agent/src/mastra/child-continuation.ts,
 * removed with BST-1935): the final completed leg's text only.
 */
export function describeHostChildContinuation(entry: HostChildDeliveryEntry): string {
  const contents = JSON.stringify({
    childThreadId: entry.childThreadId,
    continuationId: entry.childRunId,
    result: entry.outcome,
    status: 'completed',
  });
  return `<child_continuation_result>${contents}</child_continuation_result>`;
}

/** A parent run's own messages with each delivered outcome in place of its acknowledgement. */
export function overlayHostChildOutcomes(
  runId: string,
  messages: readonly ModelMessage[],
  entries: readonly HostChildDeliveryEntry[]
): ModelMessage[] {
  // A follow-up answered no tool call; only invocation outcomes replace acknowledgements.
  const outcomes = new Map(
    entries
      .filter((entry) => entry.parentRunId === runId && !entry.followUp)
      .map((entry) => [entry.toolCallId, entry.outcome])
  );
  if (outcomes.size === 0) {
    return [...messages];
  }
  return messages.map((message) =>
    message.role === 'tool'
      ? {
          ...message,
          content: message.content.map((part) => {
            const outcome = part.type === 'tool-result' ? outcomes.get(part.toolCallId) : undefined;
            return outcome === undefined || part.type !== 'tool-result'
              ? part
              : { ...part, output: { type: 'text' as const, value: outcome } };
          }),
        }
      : message
  );
}
