/**
 * BST-1932: what a parent's model reads about its background children. The
 * wording is the shipped wake ledger (packages/agent/src/mastra/
 * background-ledger.ts, removed with BST-1935). The ledger is the delivering
 * turn's own message, so it carries each outcome it delivers: a bounded or
 * observed history window drops the parent's older tool results, and an
 * outcome kept only there never reaches the model.
 */
import type { UserModelMessage } from 'ai';
import type { HostChildDelivery, HostChildDeliveryEntry } from './protocol.ts';

export type HostChildLedgerState = HostChildDeliveryEntry['state'] | 'running';

export interface HostChildLedgerEntry {
  /** The name the user sees for the child (`hostChildCallSign`). */
  readonly callSign: string;
  /** The outcome this report delivers; absent when an earlier report delivered it. */
  readonly outcome?: string | undefined;
  readonly persona: string;
  readonly prompt: string;
  readonly reason?: string | undefined;
  readonly state: HostChildLedgerState;
  readonly toolCallId: string;
  readonly toolName: string;
}

/** A delivered outcome, fenced so its own Markdown cannot run into the next entry. */
function outcomeBlock(entry: HostChildLedgerEntry): string {
  return `\n<subagent_outcome callSign="${entry.callSign}">\n${entry.outcome}\n</subagent_outcome>`;
}

function describeEntry(entry: HostChildLedgerEntry): string {
  const head = `- ${entry.callSign} (${entry.toolName}, ${entry.persona}, tool call ${entry.toolCallId})`;
  const prompt = ` Prompt: "${entry.prompt}".`;
  const delivered = entry.outcome !== undefined;
  switch (entry.state) {
    case 'returned':
      return delivered
        ? `${head}: returned.${prompt} Do not execute it again. Its outcome:${outcomeBlock(entry)}`
        : `${head}: returned.${prompt} Its outcome was reported earlier in this conversation; do not execute it again.`;
    case 'failed':
      return `${head}: failed — ${entry.reason ?? 'no reason recorded'}.${prompt} Do not retry it unless the user asks.${
        delivered
          ? ` What it reported:${outcomeBlock(entry)}`
          : ' Its failure was reported earlier in this conversation.'
      }`;
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
      ? `All ${entries.length} background invocations have finished. Nothing is still running. Continue with the task using their outcomes.`
      : 'Do not re-dispatch a running invocation; its outcome will be delivered.',
    'The user sees each subagent by its call sign: name a subagent by its call sign when you tell the user about it, never by its tool call or task ID.'
  );
  return lines.join('\n');
}

const CONTINUATION_STATUS = {
  cancelled: 'cancelled',
  failed: 'failed',
  returned: 'completed',
} as const satisfies Record<HostChildDeliveryEntry['state'], string>;

/**
 * A completed follow-up typed into an idle child, or the run that took a
 * child's human input however it ended, reaches its parent as the shipped
 * continuation notification (packages/agent/src/mastra/child-continuation.ts,
 * removed with BST-1935): its final leg's text and how it ended.
 */
export function describeHostChildContinuation(
  entry: HostChildDeliveryEntry,
  callSign: string
): string {
  const contents = JSON.stringify({
    callSign,
    childThreadId: entry.childThreadId,
    continuationId: entry.childRunId,
    result: entry.outcome,
    status: CONTINUATION_STATUS[entry.state],
  });
  return `<child_continuation_result>${contents}</child_continuation_result>`;
}

/**
 * A committed user turn as the model reads it: a next-turn delivery's ledger
 * leads the user's own input inside that one user message, so every reader
 * that rebuilds the turn from its user message keeps the ledger with it.
 */
export function withHostDeliveryLedger(
  message: UserModelMessage,
  delivery: HostChildDelivery | undefined
): UserModelMessage {
  if (delivery?.via !== 'next-turn') {
    return message;
  }
  const content =
    typeof message.content === 'string'
      ? [{ text: message.content, type: 'text' as const }]
      : message.content;
  return { ...message, content: [{ text: delivery.ledger, type: 'text' }, ...content] };
}
