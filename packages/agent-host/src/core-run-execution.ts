import { resolveAssistantResilienceConfig } from '@brainstrike/agent/provider-runtime';
import { isGuardedToolError } from '@brainstrike/assistant-contract';
import type { BlobContent } from '@brainstrike/state-store';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import {
  ApprovalInputReconstructionError,
  rebuildApprovedRuntimeMessages,
} from './approval-input.js';
import {
  type HostContextCompactions,
  overflowCompaction,
  prepareCompactedContext,
  summarizeHostContext,
} from './context-compaction.js';
import { hostContextNotes } from './context-notes.js';
import { finishHostSdkLoop, retainHostRunWork } from './core-run-lifecycle.js';
import type { HostRunState as Run } from './core-state.js';
import { healInterruptedRunHistory } from './interrupted-history.js';
import { jsonValue } from './json-value.js';
import type { HostMcpInputState } from './mcp-input-state.js';
import type { HostPlatform, HostRunAdmission, HostRunOwner, HostTool } from './ports.js';
import {
  applyProjectionRewrites,
  type HostProjectionRewrites,
  prepareProjectionRewrites,
} from './projection-rewrites.js';
import type { HostEvent, HostLogRow, HostRunTelemetry } from './protocol.js';
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
} from './run-admission.js';
import { hostRunAttemptEvent } from './run-attempts.js';
import { hostRunAncestors, hostRunContext } from './run-branch.js';
import { resolveHostApprovalInput } from './run-continuation.js';
import { HostRunOutcome } from './run-outcome.js';
import { stopHostStreamAttempt, watchHostStream } from './run-stream-watchdog.js';
import { hostArtifactReader } from './tool-artifacts.js';
import type { HostToolRecords } from './tool-records.js';

export type HostRunAction = Extract<HostEvent, { type: 'effect.started' }>;

/**
 * SDK request retries per model step (exponential backoff from 2s, provider
 * Retry-After honored up to 60s, abort-aware). The SDK retries only a request
 * whose response stream never opened, with an `isRetryable` provider error:
 * nothing of that request reached the log, `prepareStep` ran once outside the
 * retry, and no tool executes inside it. Each attempt commits its own
 * `provider.request.prepared` receipt. Subscription quota is typed
 * non-retryable below this boundary by the provider request middleware.
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
  finish(
    run: Run,
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ): Promise<void>;
  fold(row: HostLogRow): void;
  foldRows(rows: readonly HostLogRow[]): void;
  readonly mcpInputs: HostMcpInputState;
  openRun(run: Run): Promise<HostRunOwner | undefined>;
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
  await ensureHostRunAdmission(ports.platform, run);
  const output = registered.delegation
    ? await ports.delegate(run, action, input)
    : await executeRegisteredTool(ports, run, action, registered, input, resumeData);
  const [finished] = await ports.append(run.threadId, [
    {
      output: jsonValue(output),
      runId: run.id,
      toolCallId: action.toolCallId,
      type: 'effect.finished',
    },
  ]);
  run.outputs.set(action.toolCallId, jsonValue(output));
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
  // The public SDK already validated/transformed this exact admitted input.
  // Revalidating a canonical value can transform it a second time.
  return await registered.execute(input, {
    ...(resumeData === undefined ? {} : { resumeData }),
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
    signal: run.controller.signal,
    threadId: run.threadId,
    toolCallId: action.toolCallId,
    write: async (chunk: unknown): Promise<void> => {
      run.controller.signal.throwIfAborted();
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
export async function recoverHostContextOverflow(
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
 * overlay (and a new compaction past the trigger), in the legacy order.
 */
async function prepareRunContext(
  ports: HostRunExecutionPorts,
  run: Run,
  ancestors: readonly Run[],
  admission: HostRunAdmission,
  messages: readonly ModelMessage[]
): Promise<{ readonly messages: ModelMessage[]; readonly note?: string }> {
  const healed = healInterruptedRunHistory(messages, ancestors, run.threadId);
  const rewritten = await rewriteRunContext(ports, run, ancestors, healed);
  return await prepareCompactedContext({
    chain: [...ancestors, run],
    commit: (event) => commitContextEvent(ports, run, event),
    compactions: ports.compactions.read(run.threadId),
    inputTokenLimit: admission.inputTokenLimit,
    messages: rewritten,
    signal: run.controller.signal,
    summarize: (transcript) =>
      summarizeHostContext(admission.model, run.modelId, transcript, run.controller.signal),
  });
}

/** How one SDK attempt ended; Core decides between a new attempt and the run's finish. */
interface HostSdkAttempt {
  readonly checkpointFailure: unknown;
  readonly interrupted: boolean;
  /** The leg's attempt budget; absent when the resilience config could not be read. */
  readonly maxAttempts: number | undefined;
  readonly outcome: HostRunOutcome;
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
  // An empty reply is judged per attempt: a failed attempt's text never
  // entered the transcript, so only a leg that began with committed steps
  // counts as the model having contributed.
  const resumed = run.steps > 0;
  // BST-1932: a child's execution deadline bounds each leg, across its attempts.
  const deadline = ports.armDeadline(run);
  for (let attempt = 1; ; attempt += 1) {
    const ended = await runHostSdkAttempt(ports, run, model, resumed);
    if (ended.checkpointFailure !== undefined) {
      clearTimeout(deadline);
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
    clearTimeout(deadline);
    await finishHostSdkLoop(
      run,
      ports.closing(),
      ended.outcome.detail(),
      ended.interrupted,
      (joined, detail) => ports.finish(run, joined, detail)
    );
    return;
  }
}

/** One public SDK attempt over the run's committed branch; every step commits before it is observed. */
async function runHostSdkAttempt(
  ports: HostRunExecutionPorts,
  run: Run,
  model: LanguageModel,
  resumed: boolean
): Promise<HostSdkAttempt> {
  const outcome = new HostRunOutcome(run.admission?.configuration, run.modelId, resumed);
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
  try {
    // Strict: a malformed resilience setting fails this run visibly.
    const resilience = resolveAssistantResilienceConfig();
    maxAttempts = resilience.streamStallAttempts;
    // The SDK call's own signal: a watchdog expiry ends provider work without
    // reading as the user's Stop.
    const attempt = new AbortController();
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
      prepareStep: async ({ messages }) => {
        // Resolved approval tool results precede the first model call in the SDK.
        // Commit those public SDK messages before the provider sees them.
        if (messages.length > recordedInputLength) {
          await ports.commitMessages(run, messages.slice(recordedInputLength));
          recordedInputLength = messages.length;
        }
        let prepared = messages;
        if (historyPrepared) {
          // Stale reads and old outputs are rewritten within the run, as legacy
          // rewrote them after each tracked tool.
          prepared = await rewriteRunContext(ports, run, ancestors, messages);
        } else {
          historyPrepared = true;
          const overlay = await prepareRunContext(ports, run, ancestors, admission, messages);
          prepared = overlay.messages;
          compactionNote = overlay.note;
          recordedInputLength = prepared.length;
        }
        const memory = await owner?.prepareHostStep?.({
          messages: prepared,
          stepNumber: run.steps,
        });
        recordedInputLength = memory?.messages.length ?? prepared.length;
        // Per-step notes from committed thread state (the legacy task-list note).
        const notes = hostContextNotes(hostRunTools(run), ports.records.stateView(run.threadId));
        const system = combineHostSystemContext(
          combineHostSystemContext(memory?.system, compactionNote).system,
          notes
        ).system;
        const activeTools = await hostStepActiveTools(run, ports.platform);
        const gated = activeTools ? { activeTools } : {};
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
      toolApproval: ({ toolCall }) => decideHostSdkApproval(run, ports.platform, toolCall),
      tools: createAdmittedHostSdkTools(run, (action, input) => ports.dispatch(run, action, input)),
    });
    const tools = hostRunTools(run);
    const watched = watchHostStream(
      result.fullStream,
      resilience,
      (toolName) => Object.hasOwn(tools, toolName),
      (error) => stopHostStreamAttempt(run, attempt, error)
    );
    for await (const chunk of watched) {
      outcome.observe(chunk);
      await ports.append(run.threadId, [
        { chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' },
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
  return { checkpointFailure, interrupted, maxAttempts, outcome };
}
