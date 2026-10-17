/**
 * The derived "shape" of a settled conversation and the invariants it breaks:
 * the committed log's own invariants (e2e/utils/conversation-invariants.ts)
 * plus what the renderer projection makes of that log. The projection and the
 * activity-row model are the app's own (`CommittedAssistantLogProjection`,
 * `deriveActivitySteps`), fed the committed rows one at a time as a client's
 * log subscription delivers them.
 *
 * Snapshot the shape, never text: it names groups, row verbs and states,
 * paragraphs per step and title timing, so it stays stable across
 * re-recordings and changes only when the conversation's form does.
 */
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogView,
} from '@brainstrike/assistant-ui';
import { deriveActivitySteps } from '@brainstrike/assistant-ui/activity-trace-model';
import {
  type CommittedConversationShape,
  type CommittedThread,
  committedConversation,
  committedRuns,
  type InvariantViolation,
  type RenderedDelegationCard,
} from '../../../e2e/utils/conversation-invariants';

export interface StepShape {
  readonly calls: number;
  /** Text parts the step renders; each is its own markdown block. */
  readonly paragraphs: number;
  readonly reasoning: number;
}

export interface RunViewShape {
  /** The UI's part groups in order: `text`, `activity×N` (calls and reasoning), `notice`. */
  readonly groups: readonly string[];
  readonly message: string;
  readonly outcome: string;
  /** Activity rows as `<verb> <state>`, e.g. `Read done`. */
  readonly rows: readonly string[];
  readonly steps: readonly StepShape[];
}

export interface ConversationShape {
  readonly children: CommittedConversationShape['children'];
  readonly projection: string;
  readonly runs: readonly RunViewShape[];
  readonly title: CommittedConversationShape['title'];
}

type Message = CommittedAssistantLogView['repository']['messages'][number]['message'];
type Part = Message['content'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStepStart(part: Part): boolean {
  return (
    part.type === 'data' &&
    part.name === 'brainstrike.host-stream' &&
    isRecord(part.data) &&
    part.data['type'] === 'start-step'
  );
}

function isReasoningWithText(part: Part): boolean {
  return part.type === 'reasoning' && part.text.trim().length > 0;
}

/** Draws nothing between two texts: bookkeeping data and reasoning with nothing to show. */
function isTransparent(part: Part): boolean {
  return part.type === 'data' || (part.type === 'reasoning' && !isReasoningWithText(part));
}

/**
 * The vendor's per-part status rule (`toMessagePartStatus` in
 * `@assistant-ui/core/dist/utils/normalizePartStatus.js`), which fills a part's
 * status at render time; @assistant-ui/core is not a dependency to import.
 */
function partStatus(message: Message, index: number, part: Part): unknown {
  if (part.type === 'tool-call') {
    return part.result === undefined ? message.status : { type: 'complete' };
  }
  const status = message.status;
  if (status?.type === 'running' && 'status' in part && isRecord(part.status)) {
    return part.status;
  }
  if (status?.type === 'requires-action') {
    return { type: 'complete' };
  }
  return index === Math.max(0, message.content.length - 1) ? status : { type: 'complete' };
}

/**
 * A message's steps as the thread draws them (split at each `start-step`), and
 * the steps (1-based) in which two text parts sit next to each other with
 * nothing drawn between them: two markdown blocks where the model sent one text.
 */
export function renderedSteps(message: Message): { adjacent: number[]; steps: StepShape[] } {
  const steps: StepShape[] = [];
  const adjacent: number[] = [];
  let current: { calls: number; paragraphs: number; reasoning: number } | undefined;
  let textOpen = false;
  for (const part of message.content) {
    if (isStepStart(part)) {
      current = { calls: 0, paragraphs: 0, reasoning: 0 };
      steps.push(current);
      textOpen = false;
      continue;
    }
    if (!current || isTransparent(part)) {
      continue;
    }
    if (part.type === 'text') {
      current.paragraphs += 1;
      if (textOpen) {
        adjacent.push(steps.length);
      }
      textOpen = true;
      continue;
    }
    textOpen = false;
    if (part.type === 'tool-call') {
      current.calls += 1;
    } else if (isReasoningWithText(part)) {
      current.reasoning += 1;
    }
  }
  return { adjacent, steps };
}

/** The groups the thread draws: adjacent calls and reasoning share one activity group. */
function groupsOf(message: Message): string[] {
  const groups: string[] = [];
  let activity = 0;
  const flush = (): void => {
    if (activity > 0) {
      groups.push(`activity×${activity}`);
      activity = 0;
    }
  };
  for (const part of message.content) {
    if (part.type === 'tool-call' || isReasoningWithText(part)) {
      activity += 1;
    } else if (part.type === 'text') {
      flush();
      groups.push('text');
    } else if (part.type === 'data' && part.name === 'brainstrike.run-event') {
      flush();
      groups.push(`notice:${isRecord(part.data) ? String(part.data['kind']) : 'unknown'}`);
    }
  }
  flush();
  return groups;
}

function messageStatus(message: Message): string {
  const status = message.status;
  if (!status) {
    return 'none';
  }
  return 'reason' in status && status.reason ? `${status.type}:${status.reason}` : status.type;
}

/** Folds `rows` one at a time, as a log subscription delivers them; stops at the first unreadable one. */
function project(thread: CommittedThread): { failure?: string; view: CommittedAssistantLogView } {
  const runIds = committedRuns(thread.rows).map(({ runId }) => runId);
  const projection = new CommittedAssistantLogProjection({
    identifyRun: (row) => {
      const runId = String(row.event['runId']);
      const index = runIds.indexOf(runId);
      return {
        assistantMessageId: runId,
        createdAt: new Date(0),
        parentMessageId: index > 0 ? (runIds[index - 1] ?? null) : null,
        userMessageId: `user-${runId}`,
      };
    },
    threadId: thread.threadId,
  });
  for (const row of thread.rows) {
    try {
      projection.acceptCommitted([row]);
    } catch (error) {
      return {
        failure: `seq ${row.seq} ${row.event.type}: ${error instanceof Error ? error.name : 'throw'}`,
        view: projection.getSnapshot(),
      };
    }
  }
  return { view: projection.getSnapshot() };
}

function* viewViolations(
  thread: CommittedThread,
  view: CommittedAssistantLogView
): Generator<InvariantViolation> {
  const finished = new Map(
    committedRuns(thread.rows).flatMap((run) => (run.finished ? [[run.runId, run.finished]] : []))
  );
  if (view.isRunning && committedRuns(thread.rows).every((run) => run.finished)) {
    yield {
      detail: 'the view is running after every run finished',
      invariant: 'nothing-running-after-finish',
    };
  }
  for (const { message } of view.repository.messages) {
    if (message.role !== 'assistant' || !finished.has(message.id)) {
      continue;
    }
    if (message.status?.type === 'running' || message.status?.type === 'requires-action') {
      yield {
        detail: `run ${message.id} finished but its message reads ${messageStatus(message)}`,
        invariant: 'nothing-running-after-finish',
      };
    }
    const parts = message.content.map((part, index) => ({
      ...part,
      status: partStatus(message, index, part),
    }));
    for (const step of deriveActivitySteps(parts, {})) {
      if (step.state === 'running' || step.state === 'waiting') {
        yield {
          detail: `run ${message.id}: ${step.verb.done} row reads ${step.state} after run.finished`,
          invariant: 'tool-rows-terminal-after-finish',
        };
      }
    }
    for (const step of renderedSteps(message).adjacent) {
      yield {
        detail: `run ${message.id} step ${step}: adjacent text blocks render as separate parts`,
        invariant: 'one-part-per-text-run',
      };
    }
  }
}

function runViewShape(
  view: CommittedAssistantLogView,
  runId: string,
  outcome: string
): RunViewShape {
  const message = view.repository.messages.find((entry) => entry.message.id === runId)?.message;
  if (!message) {
    return { groups: [], message: 'absent', outcome, rows: [], steps: [] };
  }
  const parts = message.content.map((part, index) => ({
    ...part,
    status: partStatus(message, index, part),
  }));
  return {
    groups: groupsOf(message),
    message: messageStatus(message),
    outcome,
    rows: deriveActivitySteps(parts, {}).map((step) => `${step.verb.done} ${step.state}`),
    steps: renderedSteps(message).steps,
  };
}

/**
 * The full shape of a settled conversation and every invariant it breaks: the
 * committed log's, then the projection's (skipped past an unreadable row, which
 * is itself the `projection-folds` violation).
 */
export function conversationShape(input: {
  readonly cards?: readonly RenderedDelegationCard[];
  readonly children: readonly CommittedThread[];
  readonly parent: CommittedThread;
}): { readonly shape: ConversationShape; readonly violations: readonly InvariantViolation[] } {
  const committed = committedConversation(input);
  const { failure, view } = project(input.parent);
  const runs = committedRuns(input.parent.rows);
  return {
    shape: {
      children: committed.shape.children,
      projection: failure ? `failed at ${failure}` : 'folded',
      runs: runs.map((run) => runViewShape(view, run.runId, run.finished?.outcome ?? 'unfinished')),
      title: committed.shape.title,
    },
    violations: [
      ...committed.violations,
      ...(failure ? [{ detail: failure, invariant: 'projection-folds' as const }] : []),
      ...(failure ? [] : viewViolations(input.parent, view)),
    ],
  };
}

export type { CommittedThread, HostLogRow, InvariantViolation };
