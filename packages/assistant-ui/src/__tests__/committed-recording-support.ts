import type { ExportedMessageRepository, ThreadMessage } from '@assistant-ui/react';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import type {
  CommittedAssistantLogSource,
  CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';
import childRecording from './fixtures/child-continuation-native-wire.json';

// ---- Recorded committed host run ----

export const committedRows: readonly CommittedAssistantLogRow[] = recording;

/**
 * Owner failure texts copied verbatim from the host source; the view must show
 * them truthfully instead of an empty successful transcript (BST-1929).
 */
export const HOST_FAILURES = [
  // packages/agent-host/src/client.ts: attach refuses another protocol/version.
  { kind: 'version', text: 'Host has an incompatible protocol or version' },
  // packages/agent-host/src/runtime.ts: the platform runtime is not acquired.
  { kind: 'runtime', text: 'Host platform has not been acquired' },
  // packages/agent-host/src/run-admission.ts: an absent admission capability.
  { kind: 'capability', text: 'Host platform has no complete run admission capability' },
] as const;

/** packages/agent-host/src/run-admission.ts: run/start refused before admission. */
export const RUN_REFUSED = 'Thread already has an active root run';
/** packages/agent-host/src/core.ts: interaction/respond refused for a stale decision. */
export const STALE_INTERACTION = 'Human interaction is stale or belongs to another run';

function rowIndex(predicate: (row: CommittedAssistantLogRow) => boolean, label: string): number {
  const index = committedRows.findIndex(predicate);
  if (index < 0) {
    throw new Error(`The committed recording has no ${label} row.`);
  }
  return index;
}

/** Index of the first recorded row with this host event type. */
export function eventIndex(type: string): number {
  return rowIndex(({ event }) => event['type'] === type, type);
}

/** Index of the last recorded `stream.chunk` row carrying this chunk type. */
function lastChunkIndex(type: string): number {
  const index = committedRows.findLastIndex(
    ({ event }) =>
      event['type'] === 'stream.chunk' &&
      (event['chunk'] as { readonly type?: unknown } | undefined)?.type === type
  );
  if (index < 0) {
    throw new Error(`The committed recording has no stream.chunk ${type} row.`);
  }
  return index;
}

const started = committedRows[eventIndex('run.started')];
const accepted = committedRows.find(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'run/start'
);
const requested = committedRows[eventIndex('interaction.requested')];
if (
  !(started && accepted && requested) ||
  typeof started.event['runId'] !== 'string' ||
  typeof started.event['prompt'] !== 'string' ||
  typeof accepted.event['commandId'] !== 'string' ||
  typeof requested.event['interactionId'] !== 'string' ||
  typeof requested.event['toolCallId'] !== 'string' ||
  typeof requested.event['toolId'] !== 'string'
) {
  throw new Error('The committed recording is missing its run, prompt or interaction identities.');
}
export const recordedThreadId = started.threadId;
export const recordedRunId = started.event['runId'];
export const recordedPrompt = started.event['prompt'];
export const recordedPromptId = accepted.event['commandId'];
export const recordedInteractionId = requested.event['interactionId'];
export const recordedToolCallId = requested.event['toolCallId'];
export const recordedToolName = requested.event['toolId'];
/** The authoritative effect output object; the projection keeps this exact reference. */
export const recordedToolResult = committedRows[eventIndex('effect.finished')]?.event['output'];

/** Prefix while the host waits for the decision: through the recorded tool-call chunk. */
export const pendingApprovalLength = committedRows.findIndex(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'interaction/respond'
);
/** The committed response suffix ends with the host's `interaction.responded`. */
export const respondedLength = eventIndex('interaction.responded') + 1;
/**
 * Prefix through the answer step's committed `start-step`: the run is active
 * and its answer step open, with no text yet. The step's text then streams as
 * live telemetry, and its `model.step` (the next row) commits it.
 */
export const answerStepLength = lastChunkIndex('start-step') + 1;
if (
  pendingApprovalLength <= eventIndex('interaction.requested') ||
  respondedLength <= pendingApprovalLength ||
  committedRows[answerStepLength]?.event['type'] !== 'model.step' ||
  recordedToolResult === undefined
) {
  throw new Error('The committed recording no longer has the expected publication order.');
}

/**
 * Passive publication of already committed prefixes plus the owner's connection
 * view. It never folds, appends, invents rows or answers commands: the store's
 * production projection does all folding, and a prefix can only grow.
 */
export class RecordedCommittedSource implements CommittedAssistantLogSource {
  private prefix = 0;
  private connected = true;
  private error: string | undefined;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => ({
    connected: this.connected,
    error: this.error,
    rows: committedRows.slice(0, this.prefix),
  });

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Publish the committed prefix that ends before `length`; it never shrinks. */
  publishPrefix(length: number): void {
    if (length < this.prefix || length > committedRows.length) {
      throw new Error('A committed prefix can only grow within the recording.');
    }
    this.prefix = length;
    this.notify();
  }

  /** The owner's connection view. A failure carries the owner's error text. */
  setConnection(connected: boolean, error?: string): void {
    this.connected = connected;
    this.error = error;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * The production store over the recorded source. The run identity resolver is
 * test-owned, exactly as in the projection tests; there is no production alias.
 */
export async function recordedStore(
  source: RecordedCommittedSource,
  baseline?: ExportedMessageRepository,
  parentMessageId: string | null = baseline?.headId ?? null
): Promise<CommittedAssistantLogStore> {
  const { CommittedAssistantLogStore: Store } = await import('../committed-assistant-log-store');
  return new Store({
    ...(baseline ? { baseline } : {}),
    identifyRun: () => ({
      assistantMessageId: recordedRunId,
      createdAt: new Date('2026-10-06T08:16:33.838Z'),
      metadata: { custom: { hostRunId: recordedRunId } },
      parentMessageId,
      userMessageId: recordedPromptId,
    }),
    source,
    threadId: recordedThreadId,
  });
}

/** The saved child-continuation answer as the committed baseline before the recorded run. */
export async function recordedBaseline(): Promise<{
  readonly baseline: ExportedMessageRepository;
  readonly saved: ThreadMessage;
}> {
  const { recordedMessage } = await import('./committed-assistant-test-support');
  const saved = await recordedMessage();
  return { baseline: { headId: saved.id, messages: [{ message: saved, parentId: null }] }, saved };
}

export const CHILD_THREAD_ID = 'child';

/**
 * Every snapshot the native child wire produces, in recorded order: the
 * child's own progressive publications. recordedMessage() keeps only the last.
 */
export async function recordedChildPublications(): Promise<readonly ThreadMessage[]> {
  const [{ fromThreadMessageLike }, { AssistantMessageAccumulator, DataStreamDecoder }] =
    await Promise.all([import('@assistant-ui/react'), import('assistant-stream')]);
  const response = new Response(childRecording.lines.join(''));
  if (!response.body) {
    throw new Error('Missing recorded child response body.');
  }
  const publications: ThreadMessage[] = [];
  for await (const snapshot of response.body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(new AssistantMessageAccumulator())) {
    publications.push(
      fromThreadMessageLike(
        {
          content: snapshot.parts,
          createdAt: new Date('2026-09-12T10:51:09.660Z'),
          id: 'parent-outcome-message',
          metadata: snapshot.metadata,
          role: 'assistant',
          status: snapshot.status,
        },
        'parent-outcome-message',
        snapshot.status
      )
    );
  }
  if (publications.length < 2) {
    throw new Error('The child recording must publish progress more than once.');
  }
  return publications;
}
