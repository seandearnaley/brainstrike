import {
  resolveAssistantResilienceConfig,
  resolveProviderError,
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
  type HostContextCompactions,
  overflowCompaction,
  prepareCompactedContext,
  summarizeHostContext,
} from './context-compaction.ts';
import { hostContextNotes } from './context-notes.ts';
import { finishHostSdkLoop, retainHostRunWork } from './core-run-lifecycle.ts';
import type { HostRunState as Run } from './core-state.ts';
import { healInterruptedRunHistory } from './interrupted-history.ts';
import { jsonValue } from './json-value.ts';
import type { HostMcpInputState } from './mcp-input-state.ts';
import { HostStepPartial, isModelStreamTelemetry } from './model-stream-telemetry.ts';
import type {
  HostEnteredWorktree,
  HostPlatform,
  HostPreparedStep,
  HostRunAdmission,
  HostRunOwner,
  HostTool,
} from './ports.ts';
import {
  applyProjectionRewrites,
  type HostProjectionRewrites,
  prepareProjectionRewrites,
} from './projection-rewrites.ts';
import type { HostEvent, HostLogRow, HostRunTelemetry, HostStepDelivery } from './protocol.ts';
import {
  combineHostSystemContext,
  createAdmittedHostSdkTools,
  decideHostSdkApproval,
  ensureHostRunAdmission,
  hostModelStepEvents,
  hostRunToolDecision,
  hostRunTools,
  hostStepActiveTools,
  prepareHostProviderStep,
} from './run-admission.ts';
import { hostRunAttemptEvent } from './run-attempts.ts';
import { hostRunAncestors, hostRunContext } from './run-branch.ts';
import { commitHostModelMessages, resolveHostApprovalInput } from './run-continuation.ts';
import { HostRunOutcome } from './run-outcome.ts';
import { stopHostStreamAttempt, watchHostStream } from './run-stream-watchdog.ts';
import { hostTelemetry } from './telemetry/host-telemetry.ts';
import { hostArtifactReader } from './tool-artifacts.ts';
import type { HostToolRecords } from './tool-records.ts';

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
  enterWorktree(
    run: Run,
    action: HostRunAction
  ): ((worktree: HostEnteredWorktree) => Promise<void>) | undefined;
  finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ): Promise<void>;
  fold(row: HostLogRow): void;
  foldRows(rows: readonly HostLogRow[]): void;
  /** ADR-0028 step 3b: the notices the running `run` takes at its next step; none when nothing is due. */
  intake(
    run: Run
  ): { readonly delivery: HostStepDelivery; readonly message: ModelMessage } | undefined;
  readonly mcpInputs: HostMcpInputState;
  openRun(run: Run): Promise<HostRunOwner | undefined>;
  /** BST-1178: the answers saved for browser origins, in Core's own StateStore. */
  readonly origins: HostBrowserOriginStore;
  readonly platform: HostPlatform;
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
  await ports.append(run.threadId, [action]);
  run.started.add(action.toolCallId);
  run.effectTools.set(action.toolCallId, action.toolCatalogId ?? action.toolId);
  run.controller.signal.throwIfAborted();
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

async function commitContextEvent(
  ports: HostRunExecutionPorts,
  run: Run,
  event: HostEvent
): Promise<void> {
  await ports.append(run.threadId, [event], 'full', (rows) => ports.foldRows(rows));
}

/** Committed tool-output rewrites, plus the policy's new ones, on this step's messages. */
function rewriteRunContext(
  ports: HostRunExecutionPorts,
  run: Run,
  ancestors: readonly Run[],
  messages: readonly ModelMessage[]
): Promise<ModelMessage[]> {
  return prepareProjectionRewrites({
    commit: (event) => commitContextEvent(ports, run, event),
    existing: ports.rewrites.read(run.threadId),
    messages,
    outputs: new Map([...ancestors, run].flatMap((turn) => [...turn.outputs])),
    runId: run.id,
    select: ports.platform.selectProjectionRewrites?.bind(ports.platform),
  });
}

/**
 * After a context overflow: commit the legacy deterministic compaction of the
 * run's branch, as its next attempt would see it. False when nothing was
 * droppable, so no recovery is claimed.
 */
async function recoverHostContextOverflow(
  ports: HostRunExecutionPorts,
  run: Run
): Promise<boolean> {
  const ancestors = hostRunAncestors(ports.runs, run);
  const healed = healInterruptedRunHistory(
    hostRunContext(ports.runs, run),
    ancestors,
    run.threadId
  );
  const event = overflowCompaction({
    chain: [...ancestors, run],
    compactions: ports.compactions.read(run.threadId),
    inputTokenLimit: run.admission?.inputTokenLimit,
    messages: applyProjectionRewrites(healed, ports.rewrites.read(run.threadId)),
  });
  if (!event) {
    return false;
  }
  await commitContextEvent(ports, run, event);
  return true;
}

/**
 * The run's first request context: heal interrupted history, apply committed
 * tool-output rewrites (and the policy's new ones), then the compaction
 * overlay (and a new compaction past the trigger), in the legacy order. With
 * Memory, the trigger measures the request Memory builds (ADR-0013), and that
 * request is the first step's.
 */
async function prepareRunContext(
  ports: HostRunExecutionPorts,
  run: Run,
  ancestors: readonly Run[],
  admission: HostRunAdmission,
  messages: readonly ModelMessage[],
  owner: HostRunOwner | undefined
): Promise<{
  readonly messages: ModelMessage[];
  readonly note?: string;
  readonly step?: HostPreparedStep;
}> {
  const healed = healInterruptedRunHistory(messages, ancestors, run.threadId);
  const rewritten = await rewriteRunContext(ports, run, ancestors, healed);
  const prepareStep = owner?.prepareHostStep?.bind(owner);
  return await prepareCompactedContext({
    chain: [...ancestors, run],
    classify: (cause) => resolveProviderError(cause, admission.configuration).failure,
    commit: (event) => commitContextEvent(ports, run, event),
    compactions: ports.compactions.read(run.threadId),
    inputTokenLimit: admission.inputTokenLimit,
    ...(prepareStep
      ? {
          prepareStep: (overlaid: readonly ModelMessage[]) =>
            prepareStep({ messages: overlaid, stepNumber: run.steps }),
        }
      : {}),
    messages: rewritten,
    signal: run.controller.signal,
    summarize: (transcript) =>
      summarizeHostContext(admission.model, run, transcript, run.controller.signal),
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
    // A stopped, closing, steered or timed-out run ends here: none asked for another attempt.
    const record =
      ended.maxAttempts === undefined ||
      run.stopped ||
      run.steered ||
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
  let ownerStepFailure: unknown;
  let maxAttempts: number | undefined;
  run.paused = false;
  const initialMessages = hostRunContext(ports.runs, run);
  const ancestors = hostRunAncestors(ports.runs, run);
  let recordedInputLength = initialMessages.length;
  let historyPrepared = false;
  let compactionNote: string | undefined;
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
    const owner = await ports.openRun(run);
    const admission = await ensureHostRunAdmission(ports.platform, run);
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
      model: owner?.prepareHostModel?.(model) ?? model,
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
          return;
        }
        try {
          await owner?.commitHostStep?.();
        } catch (cause) {
          run.controller.abort(cause);
          // While the host closes, the run cannot commit its own failure, so the
          // lost checkpoint must reject close with its original cause.
          if (ports.closing()) {
            checkpointFailure = cause;
            return;
          }
          // The step is committed; its owner (Memory) failed to take it. That
          // ends the run as failed with the owner's detail, and a non-provider
          // failure is never re-attempted.
          ownerStepFailure = cause;
          outcome.fail(cause);
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
        // (a worker's report, a command's exit) reaches its model at this
        // step. The SDK carries the returned messages into the next steps.
        const intake = ports.intake(run);
        if (intake) {
          await commitHostModelMessages(
            run,
            [intake.message],
            (event) => ports.append(run.threadId, [event]).then((rows) => rows[0]),
            () => ports.syncBoundary(run.threadId),
            (row) => ports.fold(row),
            intake.delivery
          );
          messages = [...messages, intake.message];
          recordedInputLength = messages.length;
        }
        let prepared: ModelMessage[];
        let memory: HostPreparedStep | undefined;
        if (historyPrepared) {
          // Stale reads and old outputs are rewritten within the run, as legacy
          // rewrote them after each tracked tool.
          prepared = await rewriteRunContext(ports, run, ancestors, messages);
          memory = await owner?.prepareHostStep?.({
            messages: prepared,
            stepNumber: run.steps,
          });
        } else {
          historyPrepared = true;
          const overlay = await prepareRunContext(
            ports,
            run,
            ancestors,
            admission,
            messages,
            owner
          );
          prepared = overlay.messages;
          compactionNote = overlay.note;
          memory = overlay.step;
        }
        recordedInputLength = memory?.messages.length ?? prepared.length;
        // Per-step notes from committed thread state (the legacy task-list note).
        const notes = hostContextNotes(hostRunTools(run), ports.records.stateView(run.threadId));
        const system = combineHostSystemContext(
          combineHostSystemContext(memory?.system, compactionNote).system,
          notes
        ).system;
        const activeTools = await hostStepActiveTools(run, ports.platform);
        // An approved call that entered a worktree resumes with a model step:
        // it may answer, never act, in the run's old workspace (ADR-0028).
        const gated = run.enteredWorktree
          ? { activeTools: [], toolChoice: 'none' as const }
          : activeTools
            ? { activeTools }
            : {};
        if (!admission.provider) {
          return {
            messages: memory?.messages ?? prepared,
            // A UserPromptSubmit hook's context joins the run's instructions.
            ...combineHostSystemContext(system, run.promptContext),
            ...gated,
          };
        }
        const provider = await admission.provider.prepare({
          configuration: admission.configuration,
          messages: memory?.messages ?? prepared,
          modelId: run.modelId,
          signal: run.controller.signal,
          // BST-1932: a child reserves its last step for a tool-free summary.
          stepNumber: run.steps,
        });
        return {
          ...prepareHostProviderStep(provider, system, owner, run.promptContext),
          ...gated,
        };
      },
      // A committed run/steer ends the run after the step in flight (BST-588).
      stopWhen: [stepCountIs(admission.snapshot.maxSteps - run.steps), () => run.steered],
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
        chunk.type === 'error' ? { error: outcome.publicError(), type: chunk.type } : chunk;
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
  if (ownerStepFailure !== undefined) {
    // The abort that follows reaches the stream as its own error; keep the owner's.
    outcome.fail(ownerStepFailure);
  }
  return { checkpointFailure, interrupted, maxAttempts, outcome, partial: partial.message() };
}
