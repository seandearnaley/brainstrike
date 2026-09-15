import { addAbortListener } from 'node:events';
import type { DelegatedBudgetPort } from '@brainstrike/assistant-contract';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  createMastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from '../../mastra/agent-runtime';
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
  return {
    admitInvocation: async () => ({ admitted: true as const }),
    reserveStep: async ({ threadId }) => {
      const used = steps.get(threadId) ?? 0;
      if (used >= limits.maxSteps) {
        throw new Error('Delegated step budget exhausted; reserved synthesis is already consumed.');
      }
      steps.set(threadId, used + 1);
      const id = `${threadId}-step-${used + 1}`;
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
    settleStep: async () => undefined,
  };
}

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
  /** Delegation call ids the host recorded as answered without a claim, in order. */
  policyAnswers: string[];
  release: PromiseWithResolvers<void>;
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
    /** Dispatch this many independent children in one root step (`background-child-<n>`). */
    readonly siblings?: number;
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
     * Give the binding a durable-style budget port so the child runs through
     * `createDelegatedWorkBudget`: `maxSteps` working+synthesis steps, the
     * last reserved with `synthesisOutputTokens`. The child then loops reads
     * until the synthesis system message arrives and answers with a `length`
     * finish (the GLM synthesis cut).
     */
    readonly budget?: { readonly maxSteps: number; readonly synthesisOutputTokens: number };
  } = {}
): Promise<BackgroundFixture> {
  const database = await createEnginePglite();
  const scope = { resourceId: 'background-owner', threadId: 'background-root' };
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
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
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
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
  const siblings = fanout.siblings ?? 1;
  const delegationArgs = {
    // Omission preserves the production default in existing background cases.
    ...(background === undefined
      ? {}
      : { _background: typeof background === 'boolean' ? { enabled: background } : background }),
  };
  const model = scriptedAgentModel((options) => {
    if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
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
        return lengthParts('PARTIAL_CHILD_FINDINGS');
      }
      const reads = options.prompt.filter((message) => message.role === 'tool').length;
      return toolCallParts('brainstrike_grepSearch', `background-read-${reads + 1}`, {
        pattern: `evidence-${reads + 1}`,
      });
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
    if (gatedReads === 2 && !JSON.stringify(options.prompt).includes('background-read-2')) {
      return toolCallParts('brainstrike_grepSearch', 'background-read-2', {
        pattern: 'evidence-2',
      });
    }
    return textParts('CHILD_FINAL_EVIDENCE');
  });
  const runtimeData = {
    apiKey: 'test-key',
    memory: scope,
    model: 'gpt-5.4',
    ...(fanout.permissionPolicy ? { permissionPolicy: fanout.permissionPolicy } : {}),
    provider: 'openai',
    ...(signal ? { signal } : {}),
  } as const;
  let cancel: DelegatedCancellationControl | undefined;
  let decide: DelegatedDecisionControl | undefined;
  let followup: DelegatedFollowupControl | undefined;
  let activeClaim: string | undefined;
  const policyAnswers: string[] = [];
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
      ...(fanout.budget ? { budget: createScriptedBudgetPort(fanout.budget) } : {}),
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
      recordLiveDecision: async (record: DelegatedLiveDecisionRecord) => {
        liveDecisions.push(record);
      },
      recordToolActionAnswer: async (action: { toolCallId: string; delegation: unknown }) => {
        policyAnswers.push(action.toolCallId);
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
          ...(fanout.heldSibling === undefined ? [] : ['brainstrike.readWorkspaceFile']),
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
            'brainstrike.askUser': createAskUserTool(),
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
              execute: async () => ({ written: true }),
              id: 'brainstrike.writeWorkspaceFile',
              inputSchema: z.object({ pattern: z.string() }),
              requireApproval: true,
            }),
          }
        : {}),
      ...(fanout.heldSibling === undefined
        ? {}
        : {
            'brainstrike.readWorkspaceFile': createTool({
              description: 'Read a held evidence file',
              execute: async () => {
                await hold.promise;
                return { content: 'BACKGROUND_EVIDENCE' };
              },
              id: 'brainstrike.readWorkspaceFile',
              inputSchema: z.object({ pattern: z.string() }),
            }),
          }),
    },
  };
  const runtime = await createMastraAgentRuntime(options);
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
    policyAnswers,
    release,
    runtime,
    runtimeData,
    scope,
    toolSignals,
    wakeups,
  };
}
