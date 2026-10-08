/**
 * Committed branch history for host runs (BST-1929, #3543 6054972701).
 *
 * A thread's conversation is a tree: each run answers one user message, and
 * each user message follows one committed run (or the thread root). The
 * branch is committed on run.started and never rewritten. Live admission and
 * restart derive a run's branch through the same fold, and a run's model
 * context is its selected path only: a sibling branch is never on it.
 */
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  AssistantAttachmentValidationError,
  validateImageAttachmentPart,
} from '@brainstrike/assistant-contract/assistant-attachments';
import { type ModelMessage, modelMessageSchema } from 'ai';
import {
  createHostRunState,
  foldHostRunMessages,
  type HostRunBranch,
  type HostRunState,
  recordHostConversationId,
} from './core-state.js';
import {
  HOST_RESULT_SCHEMAS,
  type HostEvent,
  type HostImageAttachment,
  type HostParams,
  type HostRunSnapshot,
} from './protocol.js';
import { assertHostRunStartAvailable } from './run-admission.js';

type Started = Extract<HostEvent, { type: 'run.started' }>;

/** The run/start or run/regenerate command whose acceptance admitted a run. */
export interface HostRunAdmissionCommand {
  readonly commandId: string;
  readonly method: string;
}

/**
 * The branch a committed run.started places its run on. Live admission and
 * restart both derive it here, from the same committed event and the runs
 * already folded before it, so the two can never disagree.
 * - A regeneration answers an existing user message: its parent and prompt.
 * - A start follows its committed parent; a row committed before branch
 *   history follows the previous run, which was the only history then.
 */
export function foldHostRunBranch(
  runs: Iterable<HostRunState>,
  threadId: string,
  event: Started,
  admission: HostRunAdmissionCommand
): HostRunBranch {
  const prior = [...runs].filter((run) => run.threadId === threadId);
  if (event.userMessageId !== undefined) {
    const original = prior.find((run) => run.branch.userMessageId === event.userMessageId);
    if (admission.method !== 'run/regenerate' || !original) {
      throw new Error('Regenerated run references no committed user message in this thread');
    }
    if (original.branch.prompt !== event.prompt) {
      throw new Error('Regenerated run does not repeat its committed user message');
    }
    return original.branch;
  }
  if (admission.method !== 'run/start') {
    throw new Error('A new user message requires its committed run/start command');
  }
  const parentMessageId =
    event.parentMessageId === undefined ? (prior.at(-1)?.id ?? null) : event.parentMessageId;
  if (parentMessageId !== null && !prior.some((run) => run.id === parentMessageId)) {
    throw new Error('Committed branch parent is not an earlier run of this thread');
  }
  return {
    ...(event.attachments ? { attachments: event.attachments } : {}),
    parentMessageId,
    prompt: event.prompt,
    userMessageId: admission.commandId,
  };
}

/** A user message: its prompt alone, or its prompt followed by its images. */
function hostUserMessage(branch: HostRunBranch): ModelMessage {
  if (!branch.attachments) {
    return { content: branch.prompt, role: 'user' };
  }
  return {
    content: [
      { text: branch.prompt, type: 'text' },
      ...branch.attachments.map(
        (attachment) =>
          ({ data: attachment.data, mediaType: attachment.mediaType, type: 'file' }) as const
      ),
    ],
    role: 'user',
  };
}

/** The shared attachment contract, checked before a user message is admitted. */
function assertHostAttachments(attachments: readonly HostImageAttachment[]): void {
  let total = 0;
  for (const attachment of attachments) {
    total += validateImageAttachmentPart(attachment);
  }
  if (total > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized-combined',
      `Attachments total ${total} bytes; the limit for one message is ${ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES} bytes.`
    );
  }
}

/**
 * The selected path's committed model context for `run`: each ancestor's user
 * message and own messages, root first, then this run's. Sibling branches are
 * never on the path.
 */
export function hostRunContext(
  runs: ReadonlyMap<string, HostRunState>,
  run: HostRunState
): ModelMessage[] {
  return [...hostRunAncestors(runs, run), run].flatMap((turn) => [
    hostUserMessage(turn.branch),
    ...turn.messages,
  ]);
}

/** `run`'s ancestor runs on its committed branch, root first. */
export function hostRunAncestors(
  runs: ReadonlyMap<string, HostRunState>,
  run: HostRunState
): HostRunState[] {
  const chain: HostRunState[] = [];
  const seen = new Set([run.id]);
  for (let parent = run.branch.parentMessageId; parent !== null; ) {
    const ancestor = runs.get(parent);
    if (!ancestor || ancestor.threadId !== run.threadId) {
      throw new Error('Committed branch parent is not a run of this thread');
    }
    if (seen.has(parent)) {
      throw new Error('Committed branch links form a cycle');
    }
    seen.add(parent);
    chain.push(ancestor);
    parent = ancestor.branch.parentMessageId;
  }
  return chain.reverse();
}

/** Omitted: the current tip (the thread's latest run); null: the thread root. */
function resolveHostBranchParent(
  runs: Iterable<HostRunState>,
  threadId: string,
  requested: string | null | undefined
): string | null {
  const prior = [...runs].filter((run) => run.threadId === threadId);
  if (requested === undefined) {
    return prior.at(-1)?.id ?? null;
  }
  if (requested !== null && !prior.some((run) => run.id === requested)) {
    throw new Error('Branch parent is not a committed run of this thread');
  }
  return requested;
}

/** Committed user message `userMessageId` (its run/start command ID). */
function committedHostUserMessage(
  runs: Iterable<HostRunState>,
  threadId: string,
  userMessageId: string
): HostRunBranch {
  for (const run of runs) {
    if (run.threadId === threadId && run.branch.userMessageId === userMessageId) {
      return run.branch;
    }
  }
  throw new Error('Regenerate references no committed user message in this thread');
}

/** A started run's state, on the branch its committed run.started records. */
export function startedHostRun(
  runs: Iterable<HostRunState>,
  threadId: string,
  started: Started,
  admission: HostRunAdmissionCommand,
  snapshot?: HostRunSnapshot,
  controller?: AbortController
): HostRunState {
  return createHostRunState(
    threadId,
    started.runId,
    started.modelId,
    foldHostRunBranch(runs, threadId, started, admission),
    snapshot,
    controller
  );
}

/** Pure transcript fold into the run that committed it; HostCore owns the runs. */
export function foldHostConversationMessages(
  runs: ReadonlyMap<string, HostRunState>,
  event: Extract<HostEvent, { type: 'model.step' | 'model.messages' }>
): void {
  const run = runs.get(event.runId);
  if (!run) {
    throw new Error('Committed model messages reference an unknown run');
  }
  const messages = event.messages.map((message) => modelMessageSchema.parse(message));
  foldHostRunMessages(run, event, messages, hostRunContext(runs, run).length);
  run.messages.push(...messages);
}

/** Where a new run's user message goes. */
export type HostRunPosition = {
  readonly attachments?: HostImageAttachment[];
  readonly prompt: string;
} & ({ readonly parentMessageId: string | null } | { readonly userMessageId: string });

/** A start follows its requested parent (omitted: the current tip; null: the root). */
export function hostStartPosition(
  runs: Iterable<HostRunState>,
  params: HostParams<'run/start'>
): HostRunPosition {
  if (params.attachments) {
    assertHostAttachments(params.attachments);
  }
  return {
    ...(params.attachments ? { attachments: params.attachments } : {}),
    parentMessageId: resolveHostBranchParent(runs, params.threadId, params.parentMessageId),
    prompt: params.prompt,
  };
}

/** A regeneration answers its committed user message again. */
export function hostRegeneratePosition(
  runs: Iterable<HostRunState>,
  params: HostParams<'run/regenerate'>
): HostRunPosition {
  const { attachments, prompt } = committedHostUserMessage(
    runs,
    params.threadId,
    params.userMessageId
  );
  return {
    ...(attachments ? { attachments: [...attachments] } : {}),
    prompt,
    userMessageId: params.userMessageId,
  };
}

/** The run.started an admission commits, and its run's state on that branch. */
export function admittedHostRun(
  runs: Iterable<HostRunState>,
  admission: HostRunAdmissionCommand & {
    readonly modelId: string;
    readonly runId: string;
    readonly threadId: string;
  },
  position: HostRunPosition,
  snapshot: HostRunSnapshot,
  controller: AbortController
): { readonly run: HostRunState; readonly started: Started } {
  const started: Started = {
    ...position,
    modelId: admission.modelId,
    runId: admission.runId,
    snapshot,
    type: 'run.started',
  };
  const run = startedHostRun(runs, admission.threadId, started, admission, snapshot, controller);
  return { run, started };
}

/** Remembers a committed run admission for its run.started in the same fold batch. */
export function foldHostRunAdmission(
  admitted: Map<string, HostRunAdmissionCommand>,
  conversationIds: Set<string>,
  event: Extract<HostEvent, { type: 'command.accepted' }>
): void {
  if (event.method !== 'run/start' && event.method !== 'run/regenerate') {
    return;
  }
  recordHostConversationId(conversationIds, event.commandId);
  const { runId } = HOST_RESULT_SCHEMAS[event.method].parse(event.result);
  admitted.set(runId, { commandId: event.commandId, method: event.method });
}

/** Folds a committed run.started into `runs`, consuming its admission command. */
export function foldHostStartedRun(
  admitted: Map<string, HostRunAdmissionCommand>,
  conversationIds: Set<string>,
  runs: Map<string, HostRunState>,
  threadId: string,
  event: Started
): void {
  recordHostConversationId(conversationIds, event.runId);
  const admission = admitted.get(event.runId);
  if (!admission) {
    throw new Error('Committed run start has no committed admission command');
  }
  admitted.delete(event.runId);
  runs.set(event.runId, startedHostRun(runs.values(), threadId, event, admission, event.snapshot));
}

/** A new run needs its thread, no active run there, and an unused command identity. */
export function assertHostRunAdmissible(
  threads: ReadonlySet<string>,
  runs: Iterable<HostRunState>,
  conversationIds: ReadonlySet<string>,
  params: { readonly commandId: string; readonly threadId: string }
): void {
  if (!threads.has(params.threadId)) {
    throw new Error('Unknown thread');
  }
  assertHostRunStartAvailable(runs, params.threadId);
  if (conversationIds.has(params.commandId)) {
    throw new Error('Input command collides with a committed conversation identity');
  }
}
