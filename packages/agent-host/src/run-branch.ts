/**
 * Committed branch history for host runs (BST-1929, #3543 6054972701).
 *
 * A thread's conversation is a tree: each run answers one user message, and
 * each user message follows one committed run (or the thread root). The
 * branch is committed on run.started and never rewritten. Live admission and
 * restart derive a run's branch through the same fold, and a run's model
 * context is its selected path only: a sibling branch is never on it.
 */
import { createHash } from 'node:crypto';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  AssistantAttachmentValidationError,
  validateImageAttachmentPart,
} from '@brainstrike/assistant-contract/assistant-attachments';
import { type ModelMessage, modelMessageSchema, type UserModelMessage } from 'ai';
import { z } from 'zod';
import { overlayHostChildOutcomes, withHostDeliveryLedger } from './child-delivery.js';
import {
  createHostRunState,
  foldHostRunMessages,
  type HostRunBranch,
  type HostRunInput,
  type HostRunMap,
  type HostRunState,
  type HostThreadGrants,
  recordHostConversationId,
} from './core-state.js';
import { storedJson } from './json-value.js';
import {
  HOST_RESULT_SCHEMAS,
  type HostChildDelivery,
  type HostEvent,
  type HostImageAttachment,
  type HostParams,
  type HostRunSnapshot,
} from './protocol.js';
import { assertHostRunStartAvailable } from './run-admission.js';

/** The configuration a committed run command carried; its other fields have their own readers. */
const CommittedRunInputSchema = z.looseObject({
  configuration: z.record(z.string(), storedJson()).optional(),
});

type Started = Extract<HostEvent, { type: 'run.started' }>;

/**
 * The run/start or run/regenerate command whose acceptance admitted a run, or
 * (BST-1932) a host admission without a client command: the delegation that
 * created a child thread, keyed by the child threadId (its task is that
 * thread's first user message), or a wake, keyed by its delivery's message.
 */
export interface HostRunAdmissionCommand {
  readonly commandId: string;
  /** What an approved plan's follow-up run starts with again. */
  readonly input?: HostRunInput;
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
  /** The thread's runs folded before this one, in commit order. */
  prior: readonly HostRunState[],
  event: Started,
  admission: HostRunAdmissionCommand
): HostRunBranch {
  const delivery = event.delivery ? { delivery: event.delivery } : {};
  if (event.userMessageId !== undefined) {
    const original = prior.find((run) => run.branch.userMessageId === event.userMessageId);
    if (admission.method !== 'run/regenerate' || !original) {
      throw new Error('Regenerated run references no committed user message in this thread');
    }
    if (original.branch.prompt !== event.prompt) {
      throw new Error('Regenerated run does not repeat its committed user message');
    }
    return { ...original.branch, ...delivery };
  }
  if (admission.method === 'wake') {
    return wakeHostRunBranch(prior, event, admission);
  }
  if (admission.method === 'delegation') {
    // BST-1932: a child thread's first run answers its delegation task.
    if (event.parentMessageId !== null || prior.length > 0) {
      throw new Error('A delegated child run must start its child thread');
    }
    return { parentMessageId: null, prompt: event.prompt, userMessageId: admission.commandId };
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
    ...delivery,
    parentMessageId,
    prompt: event.prompt,
    userMessageId: admission.commandId,
  };
}

/** BST-1932: an automated wake follows the committed tip it was admitted after. */
function wakeHostRunBranch(
  prior: readonly HostRunState[],
  event: Started,
  admission: HostRunAdmissionCommand
): HostRunBranch {
  if (event.delivery?.via !== 'wake' || !event.parentMessageId) {
    throw new Error('A wake run must deliver child results after a committed run');
  }
  if (!prior.some((run) => run.id === event.parentMessageId)) {
    throw new Error('Committed branch parent is not an earlier run of this thread');
  }
  return {
    delivery: event.delivery,
    parentMessageId: event.parentMessageId,
    prompt: event.prompt,
    userMessageId: admission.commandId,
  };
}

/** A user message: its prompt alone, or its prompt (when it has one) followed by its images. */
function hostUserMessage(branch: HostRunBranch): UserModelMessage {
  if (!branch.attachments) {
    return { content: branch.prompt, role: 'user' };
  }
  return {
    content: [
      ...(branch.prompt ? [{ text: branch.prompt, type: 'text' } as const] : []),
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
  const path = [...hostRunAncestors(runs, run), run];
  // BST-1932: delivered child outcomes replace their acknowledgements from then on.
  const delivered = path.flatMap((turn) => turn.branch.delivery?.entries ?? []);
  return path.flatMap((turn) => [
    withHostDeliveryLedger(hostUserMessage(turn.branch), turn.branch.delivery),
    ...overlayHostChildOutcomes(turn.id, turn.messages, delivered),
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
  /** The thread's earlier runs, in commit order. */
  prior: readonly HostRunState[],
  threadId: string,
  started: Started,
  admission: HostRunAdmissionCommand,
  grants: HostThreadGrants,
  snapshot?: HostRunSnapshot,
  controller?: AbortController
): HostRunState {
  const run = createHostRunState(
    threadId,
    started.runId,
    started.modelId,
    foldHostRunBranch(prior, started, admission),
    grants,
    snapshot,
    controller
  );
  if (started.planMode) {
    run.planMode = true;
  }
  if (admission.input) {
    run.input = admission.input;
  }
  return run;
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
  readonly delivery?: HostChildDelivery;
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

/** What a command's run keeps to start a follow-up with: its settings and its client. */
export function hostRunInput(
  configuration: HostRunInput['configuration'] | undefined,
  origin: HostRunInput['origin'] | undefined
): HostRunInput {
  return { ...(configuration ? { configuration } : {}), ...(origin ? { origin } : {}) };
}

/** The run.started an admission commits, and its run's state on that branch. */
export function admittedHostRun(
  /** The admitting thread's earlier runs, in commit order. */
  prior: readonly HostRunState[],
  admission: HostRunAdmissionCommand & {
    readonly modelId: string;
    readonly planMode?: true | undefined;
    readonly runId: string;
    readonly threadId: string;
  },
  position: HostRunPosition,
  grants: HostThreadGrants,
  snapshot: HostRunSnapshot,
  controller: AbortController
): { readonly run: HostRunState; readonly started: Started } {
  const started: Started = {
    ...position,
    modelId: admission.modelId,
    ...(admission.planMode ? { planMode: true } : {}),
    runId: admission.runId,
    snapshot,
    type: 'run.started',
  };
  const run = startedHostRun(
    prior,
    admission.threadId,
    started,
    admission,
    grants,
    snapshot,
    controller
  );
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
  // Only a live client supplies an origin; a replayed command keeps its configuration.
  const { configuration } = CommittedRunInputSchema.parse(event.payload);
  admitted.set(runId, {
    commandId: event.commandId,
    ...(configuration ? { input: { configuration } } : {}),
    method: event.method,
  });
}

/** The admission of a child thread's first run: its delegation, keyed by the child threadId. */
export function delegatedHostRunAdmission(threadId: string): HostRunAdmissionCommand {
  return { commandId: threadId, method: 'delegation' };
}

/**
 * Folds a committed run.started into `runs`, consuming its admission command.
 * BST-1932: a child thread's first run is admitted by its delegation, and a
 * wake by its delivery; neither has a client command.
 */
export function foldHostStartedRun(
  admitted: Map<string, HostRunAdmissionCommand>,
  conversationIds: Set<string>,
  runs: HostRunMap,
  threadId: string,
  event: Started,
  grants: HostThreadGrants,
  isChildThread: (threadId: string) => boolean
): HostRunState {
  recordHostConversationId(conversationIds, event.runId);
  let admission = admitted.get(event.runId);
  const prior = runs.ofThread(threadId);
  if (!admission && isChildThread(threadId) && prior.length === 0) {
    admission = delegatedHostRunAdmission(threadId);
    recordHostConversationId(conversationIds, threadId);
  }
  if (!admission && event.delivery?.via === 'wake') {
    admission = { commandId: event.delivery.messageId, method: 'wake' };
    recordHostConversationId(conversationIds, event.delivery.messageId);
  }
  if (!admission) {
    throw new Error('Committed run start has no committed admission command');
  }
  admitted.delete(event.runId);
  const run = startedHostRun(prior, threadId, event, admission, grants, event.snapshot);
  runs.set(event.runId, run);
  return run;
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

type HostStartParams = HostParams<'run/start'>;
type HostStartImage = NonNullable<HostStartParams['attachments']>[number];

/** run/start as recorded: each image named by digest instead of its bytes. */
export type HostStartCommandRecord = Omit<HostStartParams, 'attachments'> & {
  readonly attachments?: readonly (Omit<HostStartImage, 'data'> & { readonly sha256: string })[];
};

/**
 * The durable record of a run/start command. An image is stored once: its bytes
 * are the run's (run.started), and the command record names it by digest, which
 * still detects a reused command with different images.
 */
export function hostStartCommandRecord(params: HostStartParams): HostStartCommandRecord {
  const { attachments, ...command } = params;
  if (!attachments) {
    return command;
  }
  return {
    ...command,
    attachments: attachments.map(({ data, ...image }) => ({
      ...image,
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
}
