import { addAbortListener } from 'node:events';
import {
  type DelegatedBudgetPort,
  DelegatedOutputReservationExceededError,
} from '@brainstrike/assistant-contract';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  type RuntimeSubagentSettings,
  resolveChildTaskTimeoutMs,
} from '@brainstrike/assistant-contract/subagent-settings';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import type { BackgroundTaskManager } from '@mastra/core/background-tasks';
import { createTool, type ToolExecutionContext, ToolStream } from '@mastra/core/tools';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  createMastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from '../../mastra/agent-runtime';
import { readTaskEvent, readTaskId } from '../../mastra/background-idle-loop';
import {
  createDelegatedConversationBinding,
  type DelegatedCancellationControl,
  type DelegatedConversationIdentity,
  type DelegatedDecisionControl,
  type DelegatedFollowupControl,
  type DelegatedLiveDecisionRecord,
  type DelegatedWakeupRecord,
} from '../../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../../mastra/delegated-run-publication';
import type { DelegatedSuspensionResolver } from '../../mastra/delegated-suspension-discovery';
import { LiveDecisionUnavailableError } from '../../mastra/live-decision-channel';
import { MCP_PROGRESS_STREAM_PART_TYPE } from '../../mastra/mcp-runtime-client';
import { writeShellOutputChunk } from '../../mastra/shell-output-stream';
import { createPgliteMastraMemory } from '../../pglite-mastra-memory';
import {
  hasToolResult,
  lengthParts,
  parallelToolCallParts,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../../test-fixtures/scripted-agent-model';
import { createAskUserTool } from '../../tools/ask-user-tool';
import { createSubmitPlanTool } from '../../tools/submit-plan-tool';
import type { RuntimeData } from '../../types';

/**
 * A durable-style budget port (the desktop host's `createDelegatedStepBudget`
 * in miniature): each child thread gets `maxSteps` reservations, the LAST of
 * which is the reserved synthesis forced by the step cap, carrying `used` of
 * `limit` exactly as the host reports them.
 */
function createScriptedBudgetPort(limits: {
  readonly maxSteps: number;
  readonly synthesisOutputTokens: number;
}): DelegatedBudgetPort {
  const steps = new Map<string, number>();
  const reservations = new Map<string, number>();
  return {
    admitInvocation: async () => ({ admitted: true as const }),
    readTurnLimits: async () => undefined,
    reserveStep: async ({ threadId }) => {
      const used = steps.get(threadId) ?? 0;
      if (used >= limits.maxSteps) {
        throw new Error('Delegated step budget exhausted; reserved synthesis is already consumed.');
      }
      steps.set(threadId, used + 1);
      const id = `${threadId}-step-${used + 1}`;
      reservations.set(id, used === limits.maxSteps - 1 ? limits.synthesisOutputTokens : 8192);
      return used === limits.maxSteps - 1
        ? {
            cap: 'steps' as const,
            id,
            limit: limits.maxSteps,
            outputTokens: limits.synthesisOutputTokens,
            synthesis: true as const,
            used,
          }
        : { id, outputTokens: 8192, synthesis: false as const };
    },
    settleStep: async (id, outputTokens) => {
      const reserved = reservations.get(id);
      if (reserved === undefined) {
        throw new Error('Unknown or settled reservation.');
      }
      reservations.delete(id);
      if (outputTokens !== undefined && outputTokens > reserved) {
        throw new DelegatedOutputReservationExceededError();
      }
    },
  };
}

/**
 * Resolves once `count` background tasks in `scope` are suspended. The
 * lifecycle subscription is opened BEFORE the durable rows are read, so a
 * suspension published in between is never missed.
 */
async function waitForParkedTasks(
  manager: BackgroundTaskManager,
  scope: { readonly resourceId: string; readonly threadId: string },
  count: number
): Promise<void> {
  const watching = new AbortController();
  const reader = manager
    .stream({
      abortSignal: watching.signal,
      resourceId: scope.resourceId,
      threadId: scope.threadId,
    })
    .getReader();
  try {
    const { tasks } = await manager.listTasks({ status: 'suspended' });
    const parked = new Set(tasks.map((task) => task.id));
    while (parked.size < count) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('The background lifecycle stream closed before every child parked.');
      }
      const event = readTaskEvent(value);
      const taskId = event ? readTaskId(event) : undefined;
      if (event?.type === 'background-task-suspended' && taskId) {
        parked.add(taskId);
      }
    }
  } finally {
    watching.abort();
    reader.releaseLock();
  }
}

/**
 * The generation every leg of the fixture's turn belongs to — the host's
 * migration-140 answer to "which generation is this leg?", which the desktop
 * derives from the run that opened it (initial send or regeneration). The
 * fixture answers with one constant because a fixture turn is one generation;
 * the DERIVATION itself is covered against real SQL by the `newLeg` cases of
 * `apps/desktop`'s `delegated-generation-ports.integration.test.ts`.
 */
export const FIXTURE_GENERATION_RUN_ID = 'fixture-generation-run';

interface BackgroundFixture {
  backing: Awaited<ReturnType<typeof createPgliteMastraMemory>>;
  cancel: DelegatedCancellationControl;
  database: Awaited<ReturnType<typeof createEnginePglite>>;
  /** The live decision control the running leg registered with the host. */
  decide: DelegatedDecisionControl;
  discoveryOptions: MastraAgentRuntimeOptions & {
    delegatedSuspensionDiscovery: DelegatedSuspensionResolver;
  };
  effect: ReturnType<
    typeof vi.fn<
      (_input: unknown, context?: ToolExecutionContext) => Promise<{ matches: string[] }>
    >
  >;
  entered: PromiseWithResolvers<void>;
  followup: (
    input: Parameters<DelegatedFollowupControl>[1],
    admit?: () => Promise<void>
  ) => Promise<void>;
  /** Releases the held sibling's allowed read (`fanout.heldSibling`). */
  hold: PromiseWithResolvers<void>;
  /** Every live decision the running leg asked the binding to record, in order. */
  liveDecisions: DelegatedLiveDecisionRecord[];
  model: ReturnType<typeof scriptedAgentModel>;
  /**
   * Every native ROOT run the runtime asked the host to map to this generation
   * (migration 140), in the order it started them: the first turn's run and
   * one per continuation.
   */
  nativeRootRuns: readonly string[];
  observer: ReturnType<typeof scriptedAgentModel>;
  /** Delegation call ids the host recorded as answered without a claim, in order. */
  policyAnswers: string[];
  release: PromiseWithResolvers<void>;
  rootWrite: ReturnType<typeof vi.fn>;
  runtime: Awaited<ReturnType<typeof createMastraAgentRuntime>>;
  runtimeData: RuntimeData & { memory: { resourceId: string; threadId: string } };
  scope: { resourceId: string; threadId: string };
  toolSignals: AbortSignal[];
  /**
   * Every wakeup row the binding was asked to record, in order, with how many
   * model prompts had run when it was recorded: a wakeup is recorded BEFORE the
   * inference it names.
   */
  wakeups: (DelegatedWakeupRecord & { readonly promptsAtRecord: number })[];
}

/**
 * The request settings every fixture leg carries. The tree limits are pinned
 * to small numbers (8 invocations, 2 runnable operations) because the suites
 * test exactly where a refusal lands; the long-horizon defaults would move it.
 */
export const BACKGROUND_FIXTURE_SUBAGENT_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  maxConcurrentWork: 2,
  maxInvocations: 8,
});

export async function createBackgroundFixture(
  requireApproval = false,
  signal?: AbortSignal,
  question: boolean | 'then-plan' | 'available' = false,
  background?: boolean | { enabled?: boolean; timeoutMs?: number; maxRetries?: number },
  /** Register the fixture persona as a WORKER so it may delegate (read-only personas are leaves). */
  asWorker = false,
  /** How many approval-gated reads the child issues in sequence before answering. */
  gatedReads: 1 | 2 = 1,
  fanout: {
    /** Gate the child's read through the ROOT permission policy instead of the tool flag. */
    readonly permissionPolicy?: PermissionToolGateSnapshot;
    readonly workingMemory?: boolean;
    readonly observationalMemory?: boolean;
    /** Dispatch this many independent children in one root step (`background-child-<n>`). */
    readonly siblings?: number;
    /** Admit every sibling concurrently; otherwise the two-slot refusal guard remains active. */
    readonly concurrentSiblings?: boolean;
    /** Use production-style durable work admission without forcing synthesis in the model. */
    readonly durableWork?: boolean;
    /**
     * This sibling reads through `brainstrike.readWorkspaceFile` instead, held
     * open until `hold` resolves: a running task that keeps the leg alive while
     * its siblings park (the live-decision cases).
     */
    readonly heldSibling?: number;
    /**
     * The ROOT calls its own approval-gated write (`root-write`) right after
     * dispatching; the child never sees that tool. The parent's own pause
     * while background work runs (the live-app verifier's canvas write).
     */
    readonly rootGate?: boolean;
    /**
     * The ROOT reports the final outcome only when its LAST user message (the
     * wakeup) says nothing is still running — it trusts the ledger, never its
     * own count of tool results (the GLM root mis-counted, 2026-09-15).
     */
    readonly rootReadsLedger?: boolean;
    /**
     * The ROOT dispatches a fresh `agent-explore` call on EVERY turn — the
     * broken scripted parent of `delegated-worker-write.desktop.test.ts`
     * (2026-09-15) — and stops only after this many dispatches, so a host
     * that never bounds its wakeups still lets the test end. Each turn is the
     * dispatch step plus the step that reads its acknowledgement.
     */
    readonly rootRedelegates?: number;
    /**
     * Give the binding a durable-style budget port so the child runs through
     * `createDelegatedWorkBudget`: `maxSteps` working+synthesis steps, the
     * last reserved with `synthesisOutputTokens`. The child then loops reads
     * until the synthesis system message arrives and answers with a `length`
     * finish (the GLM synthesis cut).
     */
    readonly budget?: {
      readonly maxSteps: number;
      readonly synthesisOutputTokens: number;
      readonly reportedSynthesisTokens?: number;
    };
    /**
     * The root dispatches MORE background work from CONTINUATIONS, so one turn
     * spans several native parent runs: `background-child` in the first run,
     * `background-late-1` in the first continuation, then either
     * `background-late-2` — which parks on a gated write — or, with
     * `rootGate`, the ROOT's own gated write, whose approval leg dispatches
     * `background-final`. The ledger of such a turn is the GENERATION's, not
     * one row per parent run (BST-1749, PR #3198 review item 5).
     */
    readonly continuationDispatch?: boolean;
    /**
     * The ROOT's first turn stays OPEN while its background children stream
     * and park: its post-dispatch step streams only once every dispatched
     * non-held child's task is suspended. A production root is slow there (GLM run 19,
     * 2026-09-15: parallel reads and long reasoning in the dispatching turn),
     * and a root that answers instantly closes its turn before any child
     * output exists.
     */
    readonly slowRootTurn?: boolean;
    /**
     * Send no `subagentSettings` at all (an older client), so the runtime
     * falls back to the contract defaults instead of the fixture's pinned
     * `BACKGROUND_FIXTURE_SUBAGENT_SETTINGS`.
     */
    readonly requestOmitsSubagentSettings?: boolean;
    readonly customToolOutput?: 'shell' | 'mcp';
    readonly customSuspendedToolOutput?: 'shell' | 'mcp';
  } = {}
): Promise<BackgroundFixture> {
  const database = await createEnginePglite();
  const scope = { resourceId: 'background-owner', threadId: 'background-root' };
  const observer = scriptedAgentModel((options) =>
    textParts(
      `<observations>\n- ${JSON.stringify(options.prompt).includes('CHILD_FINAL_EVIDENCE') ? 'Children returned CHILD_FINAL_EVIDENCE.' : 'Evidence requested; results pending.'}\n</observations>`
    )
  );
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    backgroundTaskTimeoutMs: resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS),
    database: {
      exec: (sql) => database.exec(sql),
      query: (sql, values) => database.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (sql) => tx.exec(sql),
            query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
          })
        ),
    },
    memoryOptions: {
      generateTitle: false,
      workingMemory: { enabled: fanout.workingMemory ?? false },
    },
    ...(fanout.observationalMemory
      ? {
          memorySettings: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
            observationalMemory: {
              ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
              enabled: true,
              messageTokens: 10,
              modelTarget: 'test/observer',
              observationTokens: 40_000,
            },
          },
          observationalMemoryModel: observer.model,
        }
      : {}),
  });
  const release = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const identities: DelegatedConversationIdentity[] = [];
  const runIdentities: DelegatedRunIdentity[] = [];
  const toolSignals: AbortSignal[] = [];
  const effect = vi.fn(async (_input: unknown, context?: ToolExecutionContext) => {
    const signal = context?.abortSignal;
    if (!signal) {
      throw new Error('Native background tool omitted its cancellation signal.');
    }
    toolSignals.push(signal);
    if (fanout.customToolOutput) {
      const writer: unknown = context?.['writer'];
      if (!(writer instanceof ToolStream)) {
        throw new Error('Native child tool omitted its stream writer.');
      }
      const toolCallId = context?.agent?.toolCallId ?? '';
      if (fanout.customToolOutput === 'shell') {
        await writeShellOutputChunk(writer, {
          chunk: 'synthetic shell output',
          stream: 'stdout',
          toolCallId,
        });
      } else {
        await writer.custom({
          progress: 1,
          toolCallId,
          toolName: 'mcp.synthetic',
          type: MCP_PROGRESS_STREAM_PART_TYPE,
        });
      }
    }
    const aborted = Promise.withResolvers<never>();
    const subscription = addAbortListener(signal, () => aborted.reject(signal.reason));
    entered.resolve();
    try {
      await Promise.race([release.promise, aborted.promise]);
      return { matches: ['BACKGROUND_EVIDENCE'] };
    } finally {
      subscription[Symbol.dispose]();
    }
  });
  const rootWrite = vi.fn(async () => ({ written: true }));
  const siblings = fanout.siblings ?? 1;
  const delegationArgs = {
    // Omission preserves the production default in existing background cases.
    ...(background === undefined
      ? {}
      : { _background: typeof background === 'boolean' ? { enabled: background } : background }),
  };
  let rootCalls = 0;
  const model = scriptedAgentModel((options) => {
    if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
      if (fanout.observationalMemory) {
        // Native observation legitimately replaces prior raw tool results.
        // A provider emits each scripted call once across that compaction.
        rootCalls += 1;
        if (rootCalls === 1) {
          return parallelToolCallParts(
            Array.from({ length: siblings }, (_, index) => ({
              args: { ...delegationArgs, prompt: `Read background evidence ${index + 1}` },
              toolCallId: `background-child-${index + 1}`,
              toolName: 'agent-explore',
            }))
          );
        }
        if (rootCalls === 2) {
          return toolCallParts('brainstrike_writeWorkspaceFile', 'root-write', {
            pattern: 'report',
          });
        }
        if (
          !(
            JSON.stringify(options.prompt).includes('CHILD_FINAL_EVIDENCE') &&
            hasToolResult(options, 'brainstrike_writeWorkspaceFile')
          )
        ) {
          throw new Error(
            'Observed root resume omitted canonical child evidence or approved write.'
          );
        }
        return textParts('PARENT_FINAL_OUTCOME');
      }
      if (fanout.rootRedelegates !== undefined) {
        rootCalls += 1;
        if (rootCalls % 2 === 0) {
          return textParts('PARENT_USEFUL_PROGRESS');
        }
        const dispatch = (rootCalls + 1) / 2;
        return dispatch > fanout.rootRedelegates
          ? textParts('PARENT_FINAL_OUTCOME')
          : toolCallParts('agent-explore', `redelegate-${dispatch}`, {
              ...delegationArgs,
              prompt: 'Read background evidence',
            });
      }
      if (!hasToolResult(options, 'agent-explore')) {
        return fanout.siblings === undefined
          ? toolCallParts('agent-explore', 'background-child', {
              ...delegationArgs,
              prompt: 'Read background evidence',
            })
          : parallelToolCallParts(
              Array.from({ length: siblings }, (_, index) => ({
                args: { ...delegationArgs, prompt: `Read background evidence ${index + 1}` },
                toolCallId: `background-child-${index + 1}`,
                toolName: 'agent-explore',
              }))
            );
      }
      if (fanout.continuationDispatch) {
        const transcript = JSON.stringify(options.prompt);
        const lastUser = JSON.stringify(
          options.prompt.filter((message) => message.role === 'user').at(-1)
        );
        // The root's own wakeup, told apart by its HEADER: the directive quotes
        // every child's prompt, so prompt text cannot identify it.
        const wokenByLedger = lastUser.includes('Background invocations of this turn');
        const returned = new Set(
          options.prompt
            .filter((message) => message.role === 'tool')
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .flatMap((part) =>
              part.type === 'tool-result' &&
              /CHILD_FINAL_EVIDENCE/.test(JSON.stringify(part.output))
                ? [part.toolCallId]
                : []
            )
        );
        const progress = textParts('PARENT_USEFUL_PROGRESS');
        if (!transcript.includes('background-late-1')) {
          return wokenByLedger && returned.has('background-child')
            ? toolCallParts('agent-explore', 'background-late-1', {
                ...delegationArgs,
                prompt: 'Read late evidence 1',
              })
            : progress;
        }
        if (fanout.rootGate) {
          if (!hasToolResult(options, 'brainstrike_writeWorkspaceFile')) {
            return wokenByLedger && returned.has('background-late-1')
              ? toolCallParts('brainstrike_writeWorkspaceFile', 'root-write', {
                  pattern: 'report',
                })
              : progress;
          }
          if (!transcript.includes('background-final')) {
            return toolCallParts('agent-explore', 'background-final', {
              ...delegationArgs,
              prompt: 'Read final evidence',
            });
          }
        } else if (!transcript.includes('background-late-2')) {
          return wokenByLedger && returned.has('background-late-1')
            ? toolCallParts('agent-explore', 'background-late-2', {
                ...delegationArgs,
                prompt: 'Gate late evidence 2',
              })
            : progress;
        }
        return textParts(
          lastUser.includes('Nothing is still running')
            ? 'PARENT_FINAL_OUTCOME'
            : 'PARENT_USEFUL_PROGRESS'
        );
      }
      if (fanout.rootGate && !hasToolResult(options, 'brainstrike_writeWorkspaceFile')) {
        return toolCallParts('brainstrike_writeWorkspaceFile', 'root-write', {
          pattern: 'report',
        });
      }
      if (fanout.rootReadsLedger) {
        const lastUser = JSON.stringify(
          options.prompt.filter((message) => message.role === 'user').at(-1)
        );
        return textParts(
          lastUser.includes('Nothing is still running')
            ? 'PARENT_FINAL_OUTCOME'
            : 'PARENT_USEFUL_PROGRESS'
        );
      }
      // Count RETURNED children by their tool-result parts: the prompt spells
      // one result's text several times (output, provider modelOutput), so a
      // substring count read one returned sibling as all of them.
      const returned = options.prompt
        .filter((message) => message.role === 'tool')
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter(
          (part) =>
            part.type === 'tool-result' &&
            /CHILD_FINAL_EVIDENCE|PARTIAL_CHILD_FINDINGS/.test(JSON.stringify(part.output))
        ).length;
      return textParts(returned >= siblings ? 'PARENT_FINAL_OUTCOME' : 'PARENT_USEFUL_PROGRESS');
    }
    if (fanout.budget) {
      const synthesis = options.prompt.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('Delegated work budget exhausted')
      );
      if (synthesis) {
        return lengthParts('PARTIAL_CHILD_FINDINGS').map((part) =>
          part.type === 'finish' && fanout.budget?.reportedSynthesisTokens !== undefined
            ? {
                ...part,
                usage: {
                  inputTokens: 1,
                  outputTokens: fanout.budget.reportedSynthesisTokens,
                  totalTokens: fanout.budget.reportedSynthesisTokens + 1,
                },
              }
            : part
        );
      }
      const reads = options.prompt.filter((message) => message.role === 'tool').length;
      return toolCallParts('brainstrike_grepSearch', `background-read-${reads + 1}`, {
        pattern: `evidence-${reads + 1}`,
      });
    }
    // The children a CONTINUATION dispatched (`continuationDispatch`): the
    // second one parks on the gated write, the others answer after one read.
    if (JSON.stringify(options.prompt).includes('Gate late evidence 2')) {
      return hasToolResult(options, 'brainstrike_readWorkspaceFile')
        ? textParts('CHILD_FINAL_EVIDENCE')
        : toolCallParts('brainstrike_readWorkspaceFile', 'late-read', { pattern: 'late' });
    }
    const lateChild = JSON.stringify(options.prompt).match(
      /Read (?:late evidence 1|final evidence)/
    )?.[0];
    if (lateChild) {
      return hasToolResult(options, 'brainstrike_grepSearch')
        ? textParts('CHILD_FINAL_EVIDENCE')
        : toolCallParts(
            'brainstrike_grepSearch',
            lateChild.includes('final') ? 'background-read-final' : 'background-read-late-1',
            { pattern: 'late' }
          );
    }
    const sibling = JSON.stringify(options.prompt).match(/Read background evidence (\d+)/)?.[1];
    const readId = sibling === undefined ? 'background-read' : `background-read-${sibling}`;
    if (sibling !== undefined && Number(sibling) === fanout.heldSibling) {
      return hasToolResult(options, 'brainstrike_readWorkspaceFile')
        ? textParts('CHILD_FINAL_EVIDENCE')
        : toolCallParts('brainstrike_readWorkspaceFile', readId, { pattern: 'evidence' });
    }
    if (question && question !== 'available' && !hasToolResult(options, 'brainstrike_askUser')) {
      return toolCallParts('brainstrike_askUser', 'background-question', {
        question: 'Which evidence should I inspect?',
      });
    }
    if (question === 'then-plan' && !hasToolResult(options, 'brainstrike_submitPlan')) {
      return toolCallParts('brainstrike_submitPlan', 'background-plan', {
        overview: 'Read the selected evidence.',
        steps: [{ title: 'Read evidence' }],
        title: 'Inspect evidence',
      });
    }
    if (!hasToolResult(options, 'brainstrike_grepSearch')) {
      return toolCallParts('brainstrike_grepSearch', readId, { pattern: 'evidence' });
    }
    const secondReadId =
      fanout.siblings && fanout.siblings > 2 && sibling !== undefined
        ? `background-read-${sibling}-second`
        : 'background-read-2';
    if (gatedReads === 2 && !JSON.stringify(options.prompt).includes(secondReadId)) {
      return toolCallParts('brainstrike_grepSearch', secondReadId, {
        pattern: 'evidence-2',
      });
    }
    return textParts('CHILD_FINAL_EVIDENCE');
  });
  // Late-bound: the runtime, and so its task manager, exists only after the model.
  let heldRuntime:
    | { readonly backgroundTaskManager?: BackgroundTaskManager | undefined }
    | undefined;
  if (fanout.slowRootTurn) {
    const scripted = model.model.doStream;
    let rootTurnHeld = false;
    model.model.doStream = async (options) => {
      if (
        !rootTurnHeld &&
        options.tools?.some((tool) => tool.name === 'agent-explore') &&
        hasToolResult(options, 'agent-explore')
      ) {
        rootTurnHeld = true;
        const manager = heldRuntime?.backgroundTaskManager;
        if (!manager) {
          throw new Error('slowRootTurn requires the runtime background task manager.');
        }
        await waitForParkedTasks(manager, scope, siblings - (fanout.heldSibling ? 1 : 0));
      }
      return scripted(options);
    };
  }
  const runtimeData = {
    apiKey: 'test-key',
    memory: scope,
    model: 'gpt-5.4',
    ...(fanout.permissionPolicy ? { permissionPolicy: fanout.permissionPolicy } : {}),
    provider: 'openai',
    ...(signal ? { signal } : {}),
    ...(fanout.requestOmitsSubagentSettings
      ? {}
      : {
          subagentSettings: {
            ...BACKGROUND_FIXTURE_SUBAGENT_SETTINGS,
            ...(fanout.concurrentSiblings ? { maxConcurrentWork: siblings } : {}),
          },
        }),
  } as const;
  let cancel: DelegatedCancellationControl | undefined;
  let decide: DelegatedDecisionControl | undefined;
  let followup: DelegatedFollowupControl | undefined;
  let activeClaim: string | undefined;
  const policyAnswers: string[] = [];
  /** The host's migration-140 mapping, in start order (see the port below). */
  const nativeRootRuns: string[] = [];
  const wakeups: BackgroundFixture['wakeups'] = [];
  const liveDecisions: DelegatedLiveDecisionRecord[] = [];
  const resolveParked = async (parent: {
    parentRuntimeRunId: string;
    parentToolCallId: string;
  }) => {
    const identity = runIdentities.find(
      (candidate) =>
        candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
        candidate.parentToolCallId === parent.parentToolCallId
    );
    const child = identities.find(
      (candidate) =>
        candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
        candidate.parentToolCallId === parent.parentToolCallId
    );
    if (!(identity && child)) {
      return;
    }
    return { identity, resourceId: child.childResourceId, threadId: child.childThreadId };
  };
  const options = {
    backgroundTaskScope: scope,
    conversationBinding: {
      ...(fanout.budget || fanout.durableWork
        ? {
            budget: createScriptedBudgetPort(
              fanout.budget ?? { maxSteps: 32, synthesisOutputTokens: 2048 }
            ),
          }
        : {}),
      // The desktop ledger holds ONE active claim per root; a second claim in
      // the same leg is refused (thread-796a942d, 2026-09-14). The fixture
      // refuses the same way so a multi-claim design cannot pass here.
      claimToolAction: async (action: { toolCallId: string }) => {
        if (activeClaim !== undefined) {
          throw new Error('tool-action-already-consumed-or-root-busy');
        }
        activeClaim = action.toolCallId;
      },
      finishToolActions: async () => {
        activeClaim = undefined;
      },
      prepareToolAction: async () => {},
      // Migration 140: the generation this leg belongs to, and every native
      // ROOT run mapped to it — the ledger's scope across legs and runs.
      readBackgroundGeneration: async () => ({
        generationRunId: FIXTURE_GENERATION_RUN_ID,
        nativeRunIds: [...nativeRootRuns],
      }),
      // The fixture holds no decision ledger, so no parked leaf is ever
      // already answered; the real host answers this from the ledger.
      readUnanswerableToolActionLeaves: async () => [],
      recordLiveDecision: async (record: DelegatedLiveDecisionRecord) => {
        liveDecisions.push(record);
      },
      recordNativeRootRun: async (nativeRunId: string) => {
        if (!nativeRootRuns.includes(nativeRunId)) {
          nativeRootRuns.push(nativeRunId);
        }
      },
      recordToolActionAnswers: async (actions: readonly { toolCallId: string }[]) => {
        policyAnswers.push(...actions.map((action) => action.toolCallId));
      },
      recordWakeup: async (record: DelegatedWakeupRecord) => {
        wakeups.push({ ...record, promptsAtRecord: model.prompts.length });
      },
      registerCancellation: (control: DelegatedCancellationControl) => {
        cancel = control;
        return () => {
          cancel = undefined;
        };
      },
      registerDecisionControl: (control: DelegatedDecisionControl) => {
        decide = control;
        return () => {
          decide = undefined;
        };
      },
      registerFollowup: (control: DelegatedFollowupControl) => {
        followup = control;
        return () => {
          followup = undefined;
        };
      },
      releaseUnexecutedToolAction: async () => {},
      resolveParkedInvocation: async (parent: {
        parentRuntimeRunId: string;
        parentToolCallId: string;
      }) => resolveParked(parent),
      resolveToolAction: async (action: {
        delegation?: unknown;
        runId: string;
        toolCallId: string;
      }) => {
        const identity = runIdentities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        const child = identities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        // Exactly the desktop host's `resolveToolAction`: the root's OWN tool
        // call (no invocation at that address, no delegation) has no ancestry;
        // a bare PARENT address of a delegation is refused by design
        // (`tool-action-leaf-identity-required`) — a resolver that skipped the
        // leaf identity passed here and failed live (thread-22c3279b,
        // 2026-09-14).
        if (!(identity && child)) {
          if (action.delegation === undefined) {
            return [];
          }
          throw new Error('tool-action-invocation-missing');
        }
        if (action.delegation === undefined) {
          throw new Error('tool-action-leaf-identity-required');
        }
        return [
          {
            configuration: child.configuration,
            identity,
            resourceId: child.childResourceId,
            threadId: child.childThreadId,
            ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          },
        ];
      },
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        runIdentities.push(identity);
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Missing native child identity');
        }
        const { messages } = await backing.memory.recall({
          perPage: false,
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        const previous = messages.findLast((message) => message.role === 'assistant');
        return { threadId: child.childThreadId, ...(previous ? { messageId: previous.id } : {}) };
      },
    },
    getDelegatedSystemContext: () => [],
    memory: backing.memory,
    model: runtimeData.model,
    modelOverride: model.model,
    personas: [
      {
        allowedToolIds: [
          'brainstrike.grepSearch',
          // Personas are READ-ONLY (`assertReadOnlyPersona`): the late child's
          // gate is an approval-gated READ, never the root's edit-risk write.
          ...(fanout.heldSibling === undefined && !fanout.continuationDispatch
            ? []
            : ['brainstrike.readWorkspaceFile']),
          ...(question ? ['brainstrike.askUser', 'brainstrike.submitPlan'] : []),
        ],
        description: 'Read evidence',
        id: 'explore',
        instructions: 'Read evidence',
        label: asWorker ? 'Worker' : 'Explorer',
        maxSteps: 4,
        ...(asWorker ? { mode: 'worker' as const } : {}),
      },
    ],
    runtime: runtimeData,
    storage: backing.storage,
    tools: {
      ...(question
        ? {
            'brainstrike.askUser': fanout.customSuspendedToolOutput
              ? createTool({
                  description: 'Ask then report tool progress',
                  execute: async (input, context) => {
                    const resume = context?.agent?.resumeData;
                    if (resume === undefined) {
                      await context?.agent?.suspend?.({ question: input.question });
                      return;
                    }
                    const writer: unknown = context?.['writer'];
                    if (!(writer instanceof ToolStream)) {
                      throw new Error('Resumed native child tool omitted its stream writer.');
                    }
                    const toolCallId = context?.agent?.toolCallId ?? '';
                    if (fanout.customSuspendedToolOutput === 'shell') {
                      await writeShellOutputChunk(writer, {
                        chunk: 'resumed shell output',
                        stream: 'stdout',
                        toolCallId,
                      });
                    } else {
                      await writer.custom({
                        progress: 1,
                        toolCallId,
                        toolName: 'mcp.synthetic',
                        type: MCP_PROGRESS_STREAM_PART_TYPE,
                      });
                    }
                    return { answer: 'evidence' };
                  },
                  id: 'brainstrike.askUser',
                  inputSchema: z.object({ question: z.string() }),
                  outputSchema: z.object({ answer: z.string() }),
                  resumeSchema: z.object({ answer: z.string() }),
                  suspendSchema: z.object({ question: z.string() }),
                })
              : createAskUserTool(),
            'brainstrike.submitPlan': createSubmitPlanTool(),
          }
        : {}),
      'brainstrike.grepSearch': createTool({
        description: 'Read evidence',
        execute: effect,
        id: 'brainstrike.grepSearch',
        inputSchema: z.object({ pattern: z.string() }),
        requireApproval,
      }),
      ...(fanout.rootGate
        ? {
            'brainstrike.writeWorkspaceFile': createTool({
              description: 'Write the report',
              execute: rootWrite,
              id: 'brainstrike.writeWorkspaceFile',
              inputSchema: z.object({ pattern: z.string() }),
              requireApproval: true,
            }),
          }
        : {}),
      ...(fanout.heldSibling === undefined && !fanout.continuationDispatch
        ? {}
        : {
            'brainstrike.readWorkspaceFile': createTool({
              description: 'Read a held evidence file',
              execute: async () => {
                if (fanout.heldSibling !== undefined) {
                  await hold.promise;
                }
                return { content: 'BACKGROUND_EVIDENCE' };
              },
              id: 'brainstrike.readWorkspaceFile',
              inputSchema: z.object({ pattern: z.string() }),
              // The late child's gate — the only child pause of the
              // continuation case, and a READ so the persona may hold it.
              ...(fanout.continuationDispatch ? { requireApproval: true } : {}),
            }),
          }),
    },
  };
  const runtime = await createMastraAgentRuntime(options);
  heldRuntime = runtime;
  return {
    backing,
    cancel: (targets: Parameters<DelegatedCancellationControl>[0]) => {
      if (!cancel) {
        throw new Error('Missing production cancellation owner');
      }
      return cancel(targets);
    },
    database,
    // The desktop registry answers a leg without a control as NOT live
    // (`deliverDesktopDelegatedDecision` → 'no-live-run'); the fixture refuses
    // the same way so a settled leg is never mistaken for a live one.
    decide: (request: Parameters<DelegatedDecisionControl>[0]) => {
      if (!decide) {
        return Promise.reject(
          new LiveDecisionUnavailableError('No running leg owns a live decision control.')
        );
      }
      return decide(request);
    },
    discoveryOptions: {
      ...options,
      delegatedSuspensionDiscovery: resolveParked,
    },
    effect,
    entered,
    followup: (input: Parameters<DelegatedFollowupControl>[1], admit = async () => {}) => {
      const child = identities[0];
      const identity = runIdentities[0];
      if (!(followup && child && identity)) {
        throw new Error('Missing production child follow-up owner');
      }
      return followup(
        {
          identity,
          personaId: child.personaId,
          resourceId: child.childResourceId,
          runId: identity.childRuntimeRunId,
          threadId: child.childThreadId,
        },
        input,
        admit
      );
    },
    hold,
    liveDecisions,
    model,
    nativeRootRuns,
    observer,
    policyAnswers,
    release,
    rootWrite,
    runtime,
    runtimeData,
    scope,
    toolSignals,
    wakeups,
  };
}
