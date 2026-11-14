import {
  resolveAssistantResilienceConfig,
  ToolExecutions,
} from '@brainstrike/agent/provider-runtime';
import { wouldTruncateMcpModelOutput } from '@brainstrike/agent/tool-runtime';
import { isGuardedToolError } from '@brainstrike/assistant-contract';
import { isToolTelemetryStreamPart } from '@brainstrike/assistant-contract/tool-telemetry';
import type { BlobContent } from '@brainstrike/state-store';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import {
  ApprovalInputReconstructionError,
  rebuildApprovedRuntimeMessages,
} from './approval-input.ts';
import type { HostBrowserOriginStore } from './browser-origin-answers.ts';
import {
  type HostCheckoutFacts,
  type HostWorktreeEnter,
  startHostEdit,
} from './checkout-isolation.ts';
import type { HostContextCompactions } from './context-compaction.ts';
import { finishHostSdkLoop, retainHostRunWork } from './core-run-lifecycle.ts';
import { type HostRunState as Run, recordHostProviderRequest } from './core-state.ts';
import { jsonValue } from './json-value.ts';
import type { HostMcpInputState } from './mcp-input-state.ts';
import { HostStepPartial, isModelStreamTelemetry } from './model-stream-telemetry.ts';
import type { HostIntake } from './notices.ts';
import { hostReadPersonInput } from './person-input.ts';
import type { HostPlatform, HostRunAdmission, HostTool } from './ports.ts';
import { hostMemoryRecord } from './project-memory-record.ts';
import { committedRewrites, type HostProjectionRewrites } from './projection-rewrites.ts';
import type { HostEvent, HostLogRow, HostRunTelemetry } from './protocol.ts';
import {
  createAdmittedHostSdkTools,
  decideHostSdkApproval,
  ensureHostRunAdmission,
  hostModelStepEvents,
  hostRunToolDecision,
  hostRunTools,
} from './run-admission.ts';
import { hostRunAttemptEvent } from './run-attempts.ts';
import { hostRunAncestors, hostRunContext } from './run-branch.ts';
import { commitHostModelMessages, resolveHostApprovalInput } from './run-continuation.ts';
import { hostProviderHistory } from './run-history.ts';
import { HostRunOutcome } from './run-outcome.ts';
import { HostProviderRequest } from './run-provider-request.ts';
import {
  hostStepRequest,
  prepareRunContext,
  recoverHostContextOverflow,
} from './run-request-context.ts';
import { stopHostStreamAttempt, watchHostStream } from './run-stream-watchdog.ts';
import { hostTelemetry } from './telemetry/host-telemetry.ts';
import { hostArtifactReader } from './tool-artifacts.ts';
import type { HostToolRecords } from './tool-records.ts';
import { isHostTurnInput } from './turn-input.ts';

/**
 * A step's finish as the log keeps it: without the provider's HTTP response
 * headers, which carry account and request identifiers and which nothing
 * reads. The AI SDK has no switch for them, as it has for request bodies.
 */
function withoutResponseHeaders<Chunk extends { readonly type: string }>(chunk: Chunk): Chunk {
  if (chunk.type !== 'finish-step' || !('response' in chunk)) {
    return chunk;
  }
  const response = chunk.response as { readonly headers?: unknown } | undefined;
  if (response?.headers === undefined) {
    return chunk;
  }
  const { headers: _headers, ...kept } = response;
  return { ...chunk, response: kept };
}

export type HostRunAction = Extract<HostEvent, { type: 'effect.started' }>;

/**
 * SDK request retries per model step (exponential backoff from 2s, provider
 * Retry-After honored up to 60s, abort-aware). The SDK retries only a request
 * whose response stream never opened, with an `isRetryable` provider error:
 * nothing of that request reached the log, `prepareStep` ran once outside the
 * retry, and no tool executes inside it. Each attempt commits its own
 * `provider.request.prepared` receipt.
 */
const HOST_PROVIDER_REQUEST_RETRIES = 2;

/** HostCore's single-writer seams that a run's SDK loop and its tool effects commit through. */
export interface HostRunExecutionPorts {
  admit<T>(threadId: string, perform: () => Promise<T>, signal: AbortSignal): Promise<T>;
  append(
    threadId: string,
    events: readonly HostEvent[],
    durability?: 'normal' | 'full',
    beforePublish?: (rows: readonly HostLogRow[]) => void,
    referenced?: readonly BlobContent[]
  ): Promise<HostLogRow[]>;
  /** BST-1932: a child's execution deadline for one leg; none for other runs. */
  armDeadline(run: Run): ReturnType<typeof setTimeout> | undefined;
  /** ADR-0034 Automatic isolation: the folded facts that say which folders runs are writing. */
  readonly checkouts: HostCheckoutFacts;
  closing(): boolean;
  commitMessages(run: Run, messages: readonly ModelMessage[]): Promise<void>;
  readonly compactions: HostContextCompactions;
  /**
   * BST-1932: a persona delegation. Core's child-run manager commits this
   * effect together with the child thread it starts, and returns its result.
   */
  delegate(run: Run, action: HostRunAction, input: unknown): Promise<unknown>;
  dispatch(run: Run, action: HostRunAction, input: unknown): Promise<unknown>;
  /** ADR-0028 step 3: a root run's call binds its thread to a worktree; none for a child. */
  enterWorktree(run: Run, action: HostRunAction): HostWorktreeEnter | undefined;
  finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ): Promise<void>;
  fold(row: HostLogRow): void;
  foldRows(rows: readonly HostLogRow[]): void;
  /** ADR-0028 step 3b: the notices the running `run` takes at its next step, one message each commit. */
  intake(run: Run): readonly HostIntake[];
  readonly mcpInputs: HostMcpInputState;
  /** BST-1178: the answers saved for browser origins, in Core's own StateStore. */
  readonly origins: HostBrowserOriginStore;
  readonly platform: HostPlatform;
  /** The run's thread's committed rows, as Core's hydration keeps them. */
  readCommittedRows(run: Run): readonly HostLogRow[];
  readonly records: HostToolRecords;
  /** The host is closing or the run's thread is being deleted. */
  retired(threadId: string): boolean;
  readonly rewrites: HostProjectionRewrites;
  readonly runs: ReadonlyMap<string, Run>;
  syncBoundary(threadId: string): Promise<void>;
  /** Publish a running tool's live telemetry to the thread's subscribers; never committed. */
  telemetry(telemetry: HostRunTelemetry): void;
}

/**
 * Whether this output reaches the model clipped by its own bounded projection
 * although its size keeps it inline — an MCP result between the run's
 * projection budget and the fixed inline ceiling. Durable settlement turns
 * that into a pageable artifact instead of an unrecoverable truncation notice
 * (the retired Mastra loop's `wouldTruncateModelOutput`, ADR-0022).
 *
 * Decided here, once, by the writer that commits the output, because artifact
 * reads must agree with settlement after a replay and a replay rebuilds
 * outputs from the committed event. Only MCP results qualify: they use the
 * generic projection, so any difference from the complete text IS loss, while
 * a native tool's own projector reshapes output legitimately and keeps its
 * documented "narrow the request" recovery.
 *
 * A run with no resolved budget has no bounded projection either: the budget
 * reaches tools only through `createAgentHostToolBindings`, which is what
 * installs `applyToolModelOutputProjections`. A platform that registers its
 * own tools directly (`platform.tools`) projects them unbounded, so nothing
 * clips and there is nothing to recover. That is why this answers false
 * instead of refusing — the capability is absent, not failing.
 */
export function projectionClipsOutput(
  admission: HostRunAdmission,
  registered: HostTool,
  action: HostRunAction,
  output: unknown
): boolean {
  if (registered.risk !== 'mcp') {
    return false;
  }
  const budget = admission.resolvedToolResultBudget;
  if (!budget) {
    return false;
  }
  return wouldTruncateMcpModelOutput(action.toolCatalogId ?? action.toolId, output, budget);
}

/** Run one admitted tool effect under its exact permission decision, committing start and output. */
export async function executeHostAction(
  ports: HostRunExecutionPorts,
  run: Run,
  action: HostRunAction,
  input: unknown,
  resumeData?: unknown
): Promise<unknown> {
  const registered = hostRunTools(run)[action.toolId];
  const permitted = run.permits.get(action.toolCallId);
  if (!registered || registered.identity !== action.toolIdentity || permitted !== action) {
    throw new Error('Tool execution lacks its exact host permission decision');
  }
  run.permits.delete(action.toolCallId);
  run.controller.signal.throwIfAborted();
  if ((await hostRunToolDecision(ports.platform, run, action.toolId)) === 'deny') {
    throw new Error('Tool permission was revoked');
  }
  run.controller.signal.throwIfAborted();
  const admission = await ensureHostRunAdmission(ports.platform, run);
  const output = registered.delegation
    ? await ports.delegate(run, action, input)
    : await executeRegisteredTool(ports, run, action, registered, input, resumeData);
  // Decided once: this append publishes without a fold, so the live run's own
  // state is updated here, exactly as a replay's fold would set it.
  const projectionClipped = projectionClipsOutput(admission, registered, action, output);
  const [finished] = await ports.append(run.threadId, [
    {
      output: jsonValue(output),
      ...(projectionClipped ? { projectionClipped: true as const } : {}),
      runId: run.id,
      toolCallId: action.toolCallId,
      type: 'effect.finished',
    },
  ]);
  run.outputs.set(action.toolCallId, jsonValue(output));
  if (projectionClipped) {
    run.artifactSettled.add(action.toolCallId);
  }
  if (finished?.ts !== undefined) {
    run.outputCommittedAt.set(action.toolCallId, finished.ts);
  }
  await commitPostToolUseContext(ports, run, action, registered, input, output);
  return output;
}

/** A PostToolUse hook's context is committed before the model reads the result. */
async function commitPostToolUseContext(
  ports: HostRunExecutionPorts,
  run: Run,
  action: HostRunAction,
  registered: HostTool,
  input: unknown,
  output: unknown
): Promise<void> {
  const post = await run.admission?.hooks?.postToolUse({
    error: isGuardedToolError(output),
    input,
    output,
    toolName: registered.permissionToolId ?? action.toolId,
  });
  if (post?.additionalContext) {
    await ports.append(
      run.threadId,
      [
        {
          context: post.additionalContext,
          runId: run.id,
          toolCallId: action.toolCallId,
          type: 'hook.context',
        },
      ],
      'full',
      ports.foldRows
    );
  }
}

/** Commit the effect's start, then run its registered executor under its run's context. */
async function executeRegisteredTool(
  ports: HostRunExecutionPorts,
  run: Run,
  action: HostRunAction,
  registered: HostTool,
  input: unknown,
  resumeData: unknown
): Promise<unknown> {
  // ADR-0034: a file edit in a folder another thread is editing is settled unrun.
  const edit = await startHostEdit(ports, run, action, registered, input, async () => {
    await ports.append(run.threadId, [action]);
    run.started.add(action.toolCallId);
    run.effectTools.set(action.toolCallId, action.toolCatalogId ?? action.toolId);
  });
  if (edit.kind === 'unrun') {
    return edit.output;
  }
  try {
    run.controller.signal.throwIfAborted();
    return await runRegisteredTool(ports, run, action, registered, input, resumeData);
  } finally {
    edit.settle();
  }
}

/** The registered executor, under its run's context. */
async function runRegisteredTool(
  ports: HostRunExecutionPorts,
  run: Run,
  action: HostRunAction,
  registered: HostTool,
  input: unknown,
  resumeData: unknown
): Promise<unknown> {
  const enterWorktree = ports.enterWorktree(run, action);
  // The public SDK already validated/transformed this exact admitted input.
  // Revalidating a canonical value can transform it a second time.
  return await registered.execute(input, {
    ...(resumeData === undefined ? {} : { resumeData }),
    ...(enterWorktree ? { enterWorktree } : {}),
    ...ports.records.context(
      run,
      action,
      () => ports.retired(run.threadId),
      (events, blobs) => ports.append(run.threadId, events, 'full', ports.foldRows, blobs)
    ),
    artifacts: hostArtifactReader(() => ports.runs.values(), run.threadId),
    mcp: ports.mcpInputs.execution(run, action, registered, {
      admit: (perform) => ports.admit(run.threadId, perform, run.controller.signal),
      append: (events, beforePublish) =>
        ports.append(run.threadId, events, 'full', (rows) => {
          for (const row of rows) {
            ports.fold(row);
          }
          beforePublish?.();
        }),
      assertCurrent: () => {
        if (ports.retired(run.threadId) || hostRunTools(run)[action.toolId] !== registered) {
          throw new Error('MCP execution authority retired');
        }
      },
      retain: (work) => retainHostRunWork(run, work),
    }),
    // ADR-0040: the memory tool's writes, committed under this call.
    memory: hostMemoryRecord({
      append: (events) => ports.append(run.threadId, events, 'full', ports.foldRows),
      rows: () => ports.readCommittedRows(run),
      runId: run.id,
      toolCallId: action.toolCallId,
      tools: hostRunTools(run),
    }),
    runId: run.id,
    // The shell's adopted worktrees arrive after the result; the run joins them.
    shellWorktrees: (adopted) =>
      retainHostRunWork(
        run,
        adopted.then(async (worktrees) => {
          if (worktrees.length > 0) {
            await ports.append(
              run.threadId,
              worktrees.map(({ branch, path, worktreeId }) => ({
                branch,
                path,
                runId: run.id,
                toolCallId: action.toolCallId,
                type: 'worktree.created' as const,
                via: 'shell' as const,
                worktreeId,
              })),
              'full',
              ports.foldRows
            );
          }
        })
      ),
    signal: run.controller.signal,
    threadId: run.threadId,
    toolCallId: action.toolCallId,
    write: async (chunk: unknown): Promise<void> => {
      run.controller.signal.throwIfAborted();
      // Live telemetry goes out uncommitted; the tool result owns the output
      // (ADR-0011 amendment). Every other tool-writer chunk commits.
      if (isToolTelemetryStreamPart(chunk)) {
        ports.telemetry({
          chunk: jsonValue(chunk),
          runId: run.id,
          threadId: run.threadId,
          toolCallId: action.toolCallId,
        });
        return;
      }
      await ports.append(run.threadId, [
        { chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' },
      ]);
    },
  });
}

/** How one SDK attempt ended; Core decides between a new attempt and the run's finish. */
interface HostSdkAttempt {
  readonly checkpointFailure: unknown;
  readonly interrupted: boolean;
  /** The leg's attempt budget; absent when the resilience config could not be read. */
  readonly maxAttempts: number | undefined;
  readonly outcome: HostRunOutcome;
  /** The open step's observed text when the attempt ended before its `model.step` committed. */
  readonly partial: ModelMessage | undefined;
}

/**
 * The run leg's SDK loop. A stall, a retryable provider error or an empty
 * reply ends one attempt; a fresh attempt over the committed branch follows
 * within the leg's budget, unless the failed step streamed tool input or a
 * call (see run-attempts.ts). Every attempt failure is committed first.
 */
export async function runHostSdkLoop(
  ports: HostRunExecutionPorts,
  run: Run,
  model: LanguageModel
): Promise<void> {
  // BST-1932: a child's execution deadline bounds each leg, across its attempts.
  const deadline = ports.armDeadline(run);
  const ended = await runHostSdkAttempts(ports, run, model).finally(() => clearTimeout(deadline));
  await finishHostSdkLoop(
    run,
    ports.closing(),
    ended.outcome.detail(),
    ended.interrupted,
    (joined, detail) => ports.finish(run, joined, detail)
  );
}

/** The leg's attempts, until one ends it. */
async function runHostSdkAttempts(
  ports: HostRunExecutionPorts,
  run: Run,
  model: LanguageModel
): Promise<HostSdkAttempt> {
  // An empty reply is judged per attempt: a failed attempt's text never
  // entered the transcript, so only a leg that began with committed steps
  // counts as the model having contributed.
  const resumed = run.steps > 0;
  for (let attempt = 1; ; attempt += 1) {
    const ended = await runHostSdkAttempt(ports, run, model, resumed);
    if (ended.checkpointFailure !== undefined) {
      throw ended.checkpointFailure;
    }
    // A stopped, closing, worktree-bound or timed-out run ends here: none asked for another attempt.
    const record =
      ended.maxAttempts === undefined ||
      run.stopped ||
      run.enteredWorktree !== undefined ||
      run.deadline !== undefined ||
      ports.closing()
        ? undefined
        : hostRunAttemptEvent(run, ended.outcome, attempt, ended.maxAttempts);
    // An overflow is re-attempted only over a branch a committed compaction
    // shortened; with nothing droppable the run fails as the provider reported.
    const recoverable =
      record?.reason !== 'context-overflow' ||
      !record.recovered ||
      (await recoverHostContextOverflow(ports, run));
    if (record && recoverable) {
      await ports.append(run.threadId, [record], 'full', ports.foldRows);
      if (record.recovered) {
        continue;
      }
    }
    // Legacy's abort finalization: a user's Stop, a terminal watchdog abort or
    // the host closing (the app quit mid-reply, BST-1982) keeps the partial
    // reply; a stall replaced by a new attempt does not. Only an unclean exit
    // loses it, since the text stream is uncommitted telemetry (ADR-0011).
    if (ended.partial && (run.stopped || ports.closing() || ended.outcome.stalled())) {
      try {
        await ports.commitMessages(run, [ended.partial]);
      } catch (cause) {
        ended.outcome.fail(cause);
      }
    }
    return ended;
  }
}

/**
 * ADR-0028 step 3b: commits what the thread was told while `run` worked, one
 * message each, and returns the step's messages with them. A person's input
 * is read first (`hostReadPersonInput`); one whose read fails stops the intake.
 */
async function takeHostIntake(
  ports: HostRunExecutionPorts,
  run: Run,
  admission: HostRunAdmission,
  input: ModelMessage[]
): Promise<{ readonly failure?: unknown; readonly messages: ModelMessage[] }> {
  let messages = input;
  for (const intake of ports.intake(run)) {
    // A message sent to an earlier run, read at this run's first step, precedes the turn's own.
    const earlier = 'input' in intake && intake.input.runId !== run.id && run.steps === 0;
    const read =
      'input' in intake
        ? await hostReadPersonInput(admission, run.id, intake.input, earlier)
        : { events: [], message: intake.message };
    if (read.events.length > 0) {
      await ports.append(run.threadId, read.events, 'normal', ports.foldRows);
    }
    await commitHostModelMessages(
      run,
      [read.message],
      (event) => ports.append(run.threadId, [event]).then((rows) => rows[0]),
      () => ports.syncBoundary(run.threadId),
      (row) => ports.fold(row),
      intake.delivery
    );
    // A blocked message is taken, never read: the run ends before its model sees it.
    if ('failure' in read) {
      return { failure: read.failure, messages };
    }
    const at = earlier ? messages.findLastIndex(isHostTurnInput) : -1;
    messages =
      at < 0
        ? [...messages, read.message]
        : [...messages.slice(0, at), read.message, ...messages.slice(at)];
  }
  return { messages };
}

/** The run's provider request boundary, kept on the run across its attempts and legs. */
function hostProviderRequest(
  ports: HostRunExecutionPorts,
  run: Run,
  admission: HostRunAdmission
): HostProviderRequest | undefined {
  if (!admission.providerRequest) {
    return;
  }
  run.providerRequest ??= new HostProviderRequest(
    admission.providerRequest,
    // Folded as a replay folds them: a trim's compaction holds from the next step.
    recordHostProviderRequest(run, (threadId, events) =>
      ports.append(threadId, events, 'full', ports.foldRows)
    )
  );
  return run.providerRequest;
}

/** One public SDK attempt over the run's committed branch; every step commits before it is observed. */
async function runHostSdkAttempt(
  ports: HostRunExecutionPorts,
  run: Run,
  model: LanguageModel,
  resumed: boolean
): Promise<HostSdkAttempt> {
  const outcome = new HostRunOutcome(run.admission?.configuration, run.modelId, resumed, {
    runId: run.id,
    threadId: run.threadId,
  });
  let interrupted = false;
  let checkpointFailure: unknown;
  let stepFailure: unknown;
  let maxAttempts: number | undefined;
  run.paused = false;
  const initialMessages = hostRunContext(ports.runs, run);
  const ancestors = hostRunAncestors(ports.runs, run);
  let recordedInputLength = initialMessages.length;
  const partial = new HostStepPartial();
  try {
    // Strict: a malformed resilience setting fails this run visibly.
    const resilience = resolveAssistantResilienceConfig();
    maxAttempts = resilience.streamStallAttempts;
    // The SDK call's own signal: a watchdog expiry ends provider work without
    // reading as the user's Stop.
    const attempt = new AbortController();
    // The watchdog never judges a running tool or delegated child (ADR-0009).
    const toolExecutions = new ToolExecutions();
    const admission = await ensureHostRunAdmission(ports.platform, run);
    const request = hostProviderRequest(ports, run, admission);
    const result = streamText({
      abortSignal: AbortSignal.any([run.controller.signal, attempt.signal]),
      maxRetries: HOST_PROVIDER_REQUEST_RETRIES,
      messages: await rebuildApprovedRuntimeMessages({
        approvals: [...run.approvals.values()],
        checkpointedResults: run.checkpointedResults,
        inputBinding: (event) => {
          const input = run.approvals.get(event.interactionId)?.runtimeInput;
          if (!input) {
            throw new Error('Approved runtime input was not acquired');
          }
          return input;
        },
        messageIndexes: run.messageIndexes,
        messages: initialMessages,
        resolveInput: (event) => resolveHostApprovalInput(run, event),
      }),
      model: request?.wrap(model) ?? model,
      onStepFinish: async (step) => {
        // AI SDK notify() catches callback errors; keep storage failures on the host's failure path.
        // https://github.com/vercel/ai/blob/main/packages/ai/src/util/notify.ts
        // Remove this capture if the public step callback propagates failures.
        try {
          // The complete public SDK context and its answerable interactions
          // share one SQLite commit, including when the provider stream is interrupted.
          const rows = await ports.append(
            run.threadId,
            hostModelStepEvents(run, step),
            'full',
            (committed) => {
              for (const row of committed) {
                ports.fold(row);
              }
            }
          );
          const row = rows[0];
          if (!row) {
            throw new Error('Model step was not committed');
          }
          recordedInputLength += step.response.messages.length;
          // The committed step owns its text from here on.
          partial.clear();
          outcome.stepCommitted(step);
        } catch (cause) {
          checkpointFailure = cause;
          run.controller.abort(cause);
        }
      },
      onToolExecutionEnd: ({ toolCall }) => toolExecutions.end(toolCall.toolCallId),
      onToolExecutionStart: ({ toolCall }) => toolExecutions.start(toolCall.toolCallId),
      prepareStep: async ({ messages: input }) => {
        let messages = input;
        // Resolved approval tool results precede the first model call in the SDK.
        // Commit those public SDK messages before the provider sees them.
        if (messages.length > recordedInputLength) {
          await ports.commitMessages(run, messages.slice(recordedInputLength));
          recordedInputLength = messages.length;
        }
        // ADR-0028 step 3b: what the thread was told while this run worked
        // (a worker's report, a command's exit, the person's message) reaches
        // its model at this step. The SDK carries the returned messages into
        // the next steps.
        const taken = await takeHostIntake(ports, run, admission, messages);
        messages = taken.messages;
        recordedInputLength = messages.length;
        // A hook's block ends the run with its reason; the message stays taken.
        if ('failure' in taken) {
          run.controller.abort(taken.failure);
          stepFailure = taken.failure;
          outcome.fail(taken.failure);
          return { messages, toolChoice: 'none' };
        }
        // BST-2531: every step's request is built from the committed branch:
        // old outputs are rewritten, and a request past its trigger compacts
        // the run's older steps first. A compaction committed at any step,
        // or before a pause, holds for every later one.
        const context = await prepareRunContext(ports, run, ancestors, admission, model);
        const prepared = context.messages;
        recordedInputLength = prepared.length;
        // What this step's requests send, read from the committed log.
        const rows = ports.readCommittedRows(run);
        request?.prepare(
          hostProviderHistory(rows, { runId: run.id, threadId: run.threadId }),
          committedRewrites(rows),
          context
        );
        return await hostStepRequest(
          ports,
          run,
          admission,
          prepared,
          request ? (stepModel) => request.wrap(stepModel) : undefined
        );
      },
      // ADR-0028 step 3: a run that entered a worktree ends after that step.
      stopWhen: [
        stepCountIs(admission.snapshot.maxSteps - run.steps),
        () => run.enteredWorktree !== undefined,
      ],
      toolApproval: ({ toolCall }) =>
        decideHostSdkApproval(run, ports.platform, ports.origins, toolCall, ports.runs),
      tools: createAdmittedHostSdkTools(run, (action, input) => ports.dispatch(run, action, input)),
      ...hostTelemetry('brainstrike.host-run', run),
    });
    const watched = watchHostStream(result.fullStream, resilience, toolExecutions, (error) =>
      stopHostStreamAttempt(run, attempt, error)
    );
    for await (const chunk of watched) {
      outcome.observe(chunk);
      // The model's text, reasoning and tool input go out live, uncommitted; the
      // step's `model.step` and the `tool-call` own them (ADR-0011 amendment).
      if (isModelStreamTelemetry(chunk)) {
        partial.observe(chunk);
        ports.telemetry({ chunk: jsonValue(chunk), runId: run.id, threadId: run.threadId });
        continue;
      }
      // observe retained/logged the original cause and resolved its safe detail.
      // SDK errors also carry requests, responses and retry graphs: none is a
      // public transcript. Reuse the terminal projection before durable publication.
      const publicChunk =
        chunk.type === 'error'
          ? { error: outcome.publicError(), type: chunk.type }
          : withoutResponseHeaders(chunk);
      await ports.append(run.threadId, [
        { chunk: jsonValue(publicChunk), runId: run.id, type: 'stream.chunk' },
      ]);
      if (chunk.type === 'finish-step') {
        await ports.syncBoundary(run.threadId);
      }
    }
  } catch (cause) {
    interrupted = cause instanceof ApprovalInputReconstructionError;
    outcome.fail(cause);
  }
  if (stepFailure !== undefined) {
    // The abort that follows reaches the stream as its own error; keep the step's.
    outcome.fail(stepFailure);
  }
  return { checkpointFailure, interrupted, maxAttempts, outcome, partial: partial.message() };
}
