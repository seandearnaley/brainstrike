import type { BlobContent } from '@brainstrike/state-store';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import {
  ApprovalInputReconstructionError,
  rebuildApprovedRuntimeMessages,
} from './approval-input.js';
import { finishHostSdkLoop, retainHostRunWork } from './core-run-lifecycle.js';
import type { HostRunState as Run } from './core-state.js';
import { healInterruptedRunHistory } from './interrupted-history.js';
import { jsonValue } from './json-value.js';
import type { HostMcpInputState } from './mcp-input-state.js';
import type { HostPlatform, HostRunOwner } from './ports.js';
import type { HostEvent, HostLogRow } from './protocol.js';
import {
  createAdmittedHostSdkTools,
  decideHostSdkApproval,
  ensureHostRunAdmission,
  hostModelStepEvents,
  hostRunToolDecision,
  hostRunTools,
  prepareHostProviderStep,
} from './run-admission.js';
import { hostRunAncestors, hostRunContext } from './run-branch.js';
import { resolveHostApprovalInput } from './run-continuation.js';
import type { HostToolRecords } from './tool-records.js';

export type HostRunAction = Extract<HostEvent, { type: 'effect.started' }>;

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
  closing(): boolean;
  commitMessages(run: Run, messages: readonly ModelMessage[]): Promise<void>;
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
  readonly runs: ReadonlyMap<string, Run>;
  syncBoundary(threadId: string): Promise<void>;
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
  await ports.append(run.threadId, [action]);
  run.started.add(action.toolCallId);
  run.controller.signal.throwIfAborted();
  // The public SDK already validated/transformed this exact admitted input.
  // Revalidating a canonical value can transform it a second time.
  const output = await registered.execute(input, {
    ...(resumeData === undefined ? {} : { resumeData }),
    ...ports.records.context(
      run,
      action,
      () => ports.retired(run.threadId),
      (events, blobs) => ports.append(run.threadId, events, 'full', ports.foldRows, blobs)
    ),
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
  await ports.append(run.threadId, [
    {
      output: jsonValue(output),
      runId: run.id,
      toolCallId: action.toolCallId,
      type: 'effect.finished',
    },
  ]);
  run.outputs.set(action.toolCallId, jsonValue(output));
  return output;
}

/** One public SDK loop over the run's committed branch; every step commits before it is observed. */
export async function runHostSdkLoop(
  ports: HostRunExecutionPorts,
  run: Run,
  model: LanguageModel
): Promise<void> {
  let failed: string | undefined;
  let interrupted = false;
  let checkpointFailure: unknown;
  let ownerStepFailure: unknown;
  run.paused = false;
  const initialMessages = hostRunContext(ports.runs, run);
  const ancestors = hostRunAncestors(ports.runs, run);
  let recordedInputLength = initialMessages.length;
  let historyPrepared = false;
  try {
    const owner = await ports.openRun(run);
    const admission = await ensureHostRunAdmission(ports.platform, run);
    const result = streamText({
      abortSignal: run.controller.signal,
      maxRetries: 0,
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
        } catch (cause) {
          checkpointFailure = cause;
          run.controller.abort(cause);
          return;
        }
        try {
          await owner?.commitHostStep?.();
        } catch (cause) {
          // The step is committed; its owner (Memory) failed to take it. That
          // ends the run as failed with the owner's detail, not a lost checkpoint.
          ownerStepFailure = cause;
          run.controller.abort(cause);
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
        if (!historyPrepared) {
          historyPrepared = true;
          prepared = healInterruptedRunHistory(messages, ancestors, run.threadId);
          recordedInputLength = prepared.length;
        }
        const memory = await owner?.prepareHostStep?.({
          messages: prepared,
          stepNumber: run.steps,
        });
        recordedInputLength = memory?.messages.length ?? prepared.length;
        if (!admission.provider) {
          return memory ?? { messages: prepared };
        }
        const provider = await admission.provider.prepare({
          configuration: admission.configuration,
          messages: memory?.messages ?? prepared,
          modelId: run.modelId,
          signal: run.controller.signal,
        });
        return prepareHostProviderStep(provider, memory?.system, owner);
      },
      // A committed run/steer ends the run after the step in flight (BST-588).
      stopWhen: [stepCountIs(admission.snapshot.maxSteps - run.steps), () => run.steered],
      toolApproval: ({ toolCall }) => decideHostSdkApproval(run, ports.platform, toolCall),
      tools: createAdmittedHostSdkTools(run, (action, input) => ports.dispatch(run, action, input)),
    });
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'error') {
        failed = chunk.error instanceof Error ? chunk.error.message : String(chunk.error);
      }
      await ports.append(run.threadId, [
        { chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' },
      ]);
      if (chunk.type === 'finish-step') {
        await ports.syncBoundary(run.threadId);
      }
    }
  } catch (cause) {
    interrupted = cause instanceof ApprovalInputReconstructionError;
    failed = cause instanceof Error ? cause.message : String(cause);
  }
  if (checkpointFailure !== undefined) {
    throw checkpointFailure;
  }
  if (ownerStepFailure !== undefined) {
    failed =
      ownerStepFailure instanceof Error ? ownerStepFailure.message : String(ownerStepFailure);
  }
  await finishHostSdkLoop(run, ports.closing(), failed, interrupted, (outcome, detail) =>
    ports.finish(run, outcome, detail)
  );
}
