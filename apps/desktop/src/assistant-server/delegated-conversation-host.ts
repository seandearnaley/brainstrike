import { createHash, randomUUID } from 'node:crypto';
import type {
  ChildContinuationHostPort,
  DelegatedConversationBinding,
  DelegatedConversationIdentity,
  DelegatedFollowupControl,
  DelegatedFollowupInput,
  DelegatedFollowupTarget,
  DelegatedRunIdentity,
  DelegatedSuspensionResolver,
  DelegatedToolActionScope,
} from '@brainstrike/agent';
import type {
  DelegatedBudgetPort,
  DelegatedConversationBaseline,
} from '@brainstrike/assistant-contract';
import {
  hasValidDelegatedToolActionTarget,
  readAdmittedPersonaConfiguration,
} from '@brainstrike/assistant-contract';
import {
  type AssistantRunEvent,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import {
  type AssistantChildRunUsage,
  isAssistantDelegatedUsageIdentity,
} from '@brainstrike/assistant-contract/run-usage';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  createDelegatedContinuationRepository,
  createDelegatedConversationRepository,
  type DelegatedConversationColor,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
  type DelegatedInvocation,
  readAssistantHistoryMessages,
  readAssistantHistoryRunEvents,
} from '@brainstrike/db';
import { z } from 'zod';
import { assertDelegatedConversationAdmission } from './delegated-cancellation-admission';
import { createDesktopDelegatedContinuationHost } from './delegated-continuation-host';
import { delegatedHostRunId } from './delegated-host-run-id';
import { createDelegatedStepBudget } from './delegated-step-budget';
import {
  assertDelegationRootRunning,
  reserveDelegatedInvocation,
} from './delegated-tree-admission';
import { desktopAssistantServerLogger as logger } from './logger';
import {
  type LiveDecisionRecord,
  type PromptManifestRecord,
  type RecordOutcome,
  recordLiveDecision,
  recordPromptManifest,
  recordWakeup,
  type WakeupRecord,
} from './swarm-diagnostics-records';

type SwarmDiagnosticRecordName = 'prompt-manifest' | 'wakeup' | 'live-decision';

/**
 * Debug-pack evidence is never runtime authority (swarm diagnostics ruling 4):
 * a missing host run or a failed insert is logged at `error` with a code — it
 * lands in the main log the pack captures — and the leg continues. Never
 * reported as recorded, never swallowed silently.
 */
async function recordSwarmDiagnostic(
  hostRunId: string,
  record: SwarmDiagnosticRecordName,
  write: () => Promise<RecordOutcome>
): Promise<void> {
  try {
    if ((await write()) === 'run-missing') {
      logger.error('Swarm diagnostic record has no host run', {
        code: 'swarm_diagnostic_record_run_missing',
        hostRunId,
        record,
      });
    }
  } catch (error) {
    logger.error('Swarm diagnostic record failed to persist', {
      code: 'swarm_diagnostic_record_failed',
      error,
      hostRunId,
      record,
    });
  }
}

const identityString = z.string().refine((value) => value.trim().length > 0);
const hostScopeSchema = z.object({
  ownerResourceId: identityString,
  rootThreadId: identityString,
  turnMessageId: identityString,
});

async function readRequiredBranchHistory(
  database: DelegatedConversationDatabase,
  threadId: string,
  resourceId: string,
  requiredMessageIds: readonly string[]
): Promise<Awaited<ReturnType<typeof readAssistantHistoryMessages>>> {
  if (requiredMessageIds.length === 0) {
    return [];
  }
  const required = new Set(requiredMessageIds);
  const captured = new Map<
    string,
    Awaited<ReturnType<typeof readAssistantHistoryMessages>>[number]
  >();
  let page = await readAssistantHistoryMessages(database, threadId, resourceId, {
    limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  });
  while (required.size > 0) {
    for (const message of page) {
      if (required.delete(message.id)) {
        captured.set(message.id, message);
      }
    }
    if (required.size === 0) {
      break;
    }
    const cursor = page[0]?.id;
    if (!cursor) {
      throw new DelegatedConversationIdentityError('continuation-branch-history-incomplete');
    }
    page = await readAssistantHistoryMessages(database, threadId, resourceId, {
      beforeMessageId: cursor,
      limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
    });
  }
  return requiredMessageIds.map((id) => {
    const message = captured.get(id);
    if (!message) {
      throw new DelegatedConversationIdentityError('continuation-branch-history-incomplete');
    }
    return message;
  });
}

function assertActionInvocation(
  invocation: DelegatedInvocation | null,
  edge: DelegatedRunIdentity,
  parentThreadId: string,
  turnMessageId: string
): asserts invocation is DelegatedInvocation {
  if (
    !invocation ||
    invocation.childRuntimeRunId !== edge.childRuntimeRunId ||
    invocation.personaId !== edge.personaId ||
    invocation.parentThreadId !== parentThreadId ||
    invocation.turnMessageId !== turnMessageId
  ) {
    throw new DelegatedConversationIdentityError('tool-action-ancestry-mismatch');
  }
}

function toolActionKey(
  action: Parameters<NonNullable<DelegatedConversationBinding['claimToolAction']>>[0]
): string {
  return JSON.stringify([
    action.runId,
    action.toolCallId,
    action.continuationId,
    action.delegation?.toolCallId,
    action.delegation?.path.map((edge) => [
      edge.parentRuntimeRunId,
      edge.parentToolCallId,
      edge.childRuntimeRunId,
      edge.personaId,
    ]),
  ]);
}

async function resolveActionParentThreadId(
  database: DelegatedConversationDatabase,
  scope: z.infer<typeof hostScopeSchema>,
  action: Parameters<NonNullable<DelegatedConversationBinding['resolveToolAction']>>[0]
): Promise<string> {
  if (!action.continuationId) {
    return scope.rootThreadId;
  }
  const continuation = await createDelegatedConversationRepository(database).getContinuation(
    scope,
    action.continuationId
  );
  if (
    !continuation ||
    continuation.nativeRunId !== action.runId ||
    continuation.turnMessageId !== scope.turnMessageId
  ) {
    throw new DelegatedConversationIdentityError('continuation-ancestry-mismatch');
  }
  return continuation.threadId;
}

const DISPLAY_IDENTITIES = [
  { color: 'blue', name: 'Cedar' },
  { color: 'emerald', name: 'Fern' },
  { color: 'amber', name: 'Aspen' },
  { color: 'rose', name: 'Maple' },
  { color: 'violet', name: 'Iris' },
  { color: 'slate', name: 'Willow' },
] as const satisfies readonly { color: DelegatedConversationColor; name: string }[];

/** Display identity only: never derive ownership or ancestry from a native id. */
function createDisplayIdentity(threadId: string): {
  color: DelegatedConversationColor;
  displayName: string;
} {
  const digest = createHash('sha256').update(threadId).digest();
  const display = DISPLAY_IDENTITIES[digest.readUInt8(0) % DISPLAY_IDENTITIES.length];
  if (!display) {
    throw new Error('Delegated conversation display palette is empty.');
  }
  return {
    color: display.color,
    displayName: `${display.name}-${digest.toString('hex').slice(0, 6)}`,
  };
}

/**
 * Every `DelegatedConversationIdentityError` that escapes the host carries a
 * bounded `reason`, but the message the run row records is generic. Log the
 * reason at the boundary so a debug pack can say WHICH admission rule refused
 * (BST-1751: none of the five failed runs in thread-f6be9761 recorded one).
 */
function withIdentityLogging<Args extends unknown[], Result>(
  hostRunId: string,
  method: string,
  operation: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    try {
      return await operation(...args);
    } catch (error) {
      if (error instanceof DelegatedConversationIdentityError) {
        // A stopped root refuses every sibling in the same storm; that is the
        // expected shape of a cancel, not an error-rate signal.
        const level = error.reason === 'delegation-root-not-running' ? 'warn' : 'error';
        logger[level]('Delegated conversation identity rejected', {
          code: 'delegated_conversation_identity_rejected',
          hostRunId,
          method,
          reason: error.reason,
        });
      }
      throw error;
    }
  };
}

function logIdentityRejections(hostRunId: string, target: object, prefix = ''): void {
  const members = target as Record<string, unknown>;
  for (const key of Object.keys(members)) {
    const value = members[key];
    if (typeof value === 'function') {
      members[key] = withIdentityLogging(
        hostRunId,
        `${prefix}${key}`,
        value as (...args: unknown[]) => Promise<unknown>
      );
    }
  }
}

/**
 * Per-host-leg authority. Native resource ids are execution scopes; the owner
 * and originating turn come exclusively from the server's persisted run row.
 * Recreated resume legs authorize the original invocation without replacing it.
 */
export function createDesktopDelegatedConversationHost(
  database: DelegatedConversationDatabase,
  hostRunId: string,
  prepareInputContext?: (
    input: DelegatedFollowupInput,
    configuration: unknown
  ) => Promise<{ role: 'system'; content: string }[]>,
  captureWorkspaceStart?: (threadId: string) => Promise<void>,
  /**
   * The request's validated per-child budgets. A streaming leg passes them so
   * the turn's budget row can be OPENED from the settings; legs that never
   * open a row (run persistence, cancel/status) pass nothing and read the row
   * the first leg stored.
   */
  subagentSettings?: RuntimeSubagentSettings
): {
  budget: DelegatedBudgetPort;
  continuation: ChildContinuationHostPort;
  sendFollowup(
    scope: DelegatedConversationScope,
    threadId: string,
    input: DelegatedFollowupInput,
    control: DelegatedFollowupControl
  ): Promise<void>;
  bindRun(identity: DelegatedRunIdentity): Promise<{
    readonly threadId: string;
    readonly messageId?: string;
    readonly baseline?: DelegatedConversationBaseline;
  }>;
  resolveToolAction: NonNullable<DelegatedConversationBinding['resolveToolAction']>;
  resolveParkedInvocation: NonNullable<DelegatedConversationBinding['resolveParkedInvocation']>;
  recordToolActionAnswer: NonNullable<DelegatedConversationBinding['recordToolActionAnswer']>;
  recordPromptManifest(record: PromptManifestRecord): Promise<void>;
  recordWakeup(record: WakeupRecord): Promise<void>;
  recordLiveDecision(record: LiveDecisionRecord): Promise<void>;
  prepareToolAction: NonNullable<DelegatedConversationBinding['prepareToolAction']>;
  claimToolAction: NonNullable<DelegatedConversationBinding['claimToolAction']>;
  finishToolActions(): Promise<void>;
  releaseUnexecutedToolAction: NonNullable<
    DelegatedConversationBinding['releaseUnexecutedToolAction']
  >;
  persist(identity: DelegatedConversationIdentity): Promise<void>;
  persistEvent(
    identity: DelegatedRunIdentity,
    messageId: string,
    event: AssistantRunEvent,
    sequence: number
  ): Promise<AssistantRunEvent>;
  persistUsage(usage: AssistantChildRunUsage): Promise<void>;
} {
  if (!hostRunId.trim()) {
    throw new DelegatedConversationIdentityError();
  }
  const repository = createDelegatedConversationRepository(database);
  const readScope = async (): Promise<z.infer<typeof hostScopeSchema>> => {
    const result = await database.query(
      `SELECT runs.resource_id AS "ownerResourceId", runs.thread_id AS "rootThreadId",
        runs.turn_message_id AS "turnMessageId"
       FROM brainstrike_assistant_thread_runs runs
       JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
       WHERE runs.id = $1`,
      [hostRunId]
    );
    const parsed = hostScopeSchema.safeParse(result.rows[0]);
    if (result.rows.length !== 1 || !parsed.success) {
      throw new DelegatedConversationIdentityError('host-scope-invalid');
    }
    return parsed.data;
  };
  // One immutable host leg belongs to one root. The partial unique root
  // index therefore permits at most one active claim in this binding.
  const claims = new Set<string>();
  let claimedActionKey: string | undefined;
  const followupTargets = new Map<string, DelegatedFollowupTarget>();
  const baselines = new Map<string, DelegatedConversationBaseline>();
  const initialBaselines = new Map<string, Promise<DelegatedConversationBaseline>>();
  const captureHistory = async (
    threadId: string,
    resourceId: string,
    initial: boolean,
    requiredMessageIds?: readonly string[],
    excludedOriginatingTurnMessageId?: string
  ): Promise<DelegatedConversationBaseline> => {
    const [messages, runEvents] = await Promise.all([
      requiredMessageIds
        ? readRequiredBranchHistory(database, threadId, resourceId, requiredMessageIds)
        : readAssistantHistoryMessages(database, threadId, resourceId, {
            limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
          }),
      readAssistantHistoryRunEvents(database, threadId, resourceId, {
        limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
      }),
    ]);
    const history: DelegatedConversationBaseline['messages'] = [];
    for (const message of messages) {
      if (initial && (message.role === 'assistant' || message.role === 'tool')) {
        continue;
      }
      history.push({ ...message, createdAt: message.createdAt.toISOString() });
    }
    let retainedRunEvents = runEvents;
    if (initial || requiredMessageIds?.length === 0) {
      retainedRunEvents = [];
    } else if (requiredMessageIds) {
      const branchMessageIds = new Set(requiredMessageIds);
      retainedRunEvents = runEvents.filter((event) => {
        const nativeMessageId = event.metadata?.['nativeMessageId'];
        const originatingTurnMessageId = event.metadata?.['originatingTurnMessageId'];
        if (typeof nativeMessageId === 'string') {
          return branchMessageIds.has(nativeMessageId);
        }
        if (typeof originatingTurnMessageId === 'string') {
          return (
            originatingTurnMessageId !== excludedOriginatingTurnMessageId &&
            branchMessageIds.has(originatingTurnMessageId)
          );
        }
        // Legacy rows without durable ownership still need the ordinary
        // chronological assignment path; absence is not evidence of exclusion.
        return true;
      });
    }
    return structuredClone({
      hostRunId,
      // Mastra generates a fresh child thread per delegation invocation. Native
      // input rows are history; this invocation's output belongs to its decoder.
      messages: history,
      runEvents: [...retainedRunEvents],
      threadId,
    });
  };
  const host: ReturnType<typeof createDesktopDelegatedConversationHost> = {
    async bindRun(identity) {
      const scope = await readScope();
      const invocation = await repository.bindInvocationRun(
        scope,
        identity,
        identity.childRuntimeRunId,
        hostRunId
      );
      if (!baselines.has(invocation.threadId) && invocation.hostRunId === hostRunId) {
        let pending = initialBaselines.get(invocation.threadId);
        if (!pending) {
          pending = (async () => {
            const node = await repository.get(scope, invocation.threadId);
            if (!node) {
              throw new DelegatedConversationIdentityError('missing-history-owner');
            }
            return captureHistory(node.threadId, node.resourceId, true);
          })();
          initialBaselines.set(invocation.threadId, pending);
        }
        baselines.set(invocation.threadId, await pending);
      }
      const baseline = baselines.get(invocation.threadId);
      const node = await repository.get(scope, invocation.threadId);
      if (!node?.parentThreadId) {
        throw new DelegatedConversationIdentityError('missing-followup-owner');
      }
      followupTargets.set(node.threadId, {
        identity,
        personaId: identity.personaId,
        resourceId: node.resourceId,
        runId: identity.childRuntimeRunId,
        threadId: node.threadId,
      });
      return {
        threadId: invocation.threadId,
        ...(baseline ? { baseline } : {}),
        ...(invocation.messageId ? { messageId: invocation.messageId } : {}),
      };
    },
    budget: createDelegatedStepBudget(database, hostRunId, readScope, subagentSettings),
    async claimToolAction(action) {
      const scopes = await host.resolveToolAction(action);
      const leaf = scopes.at(-1);
      if (!(leaf && action.delegation)) {
        throw new DelegatedConversationIdentityError('tool-action-leaf-identity-required');
      }
      const scope = await readScope();
      const id = randomUUID();
      // Native snapshot validation happens immediately before admission. The
      // unique leaf key survives completion; the partial root key prevents two
      // reconstructed native runtimes from resuming the same root concurrently.
      const result = await database.query(
        `INSERT INTO brainstrike_delegated_tool_decisions
          (id, owner_resource_id, root_thread_id, parent_runtime_run_id,
           parent_tool_call_id, child_thread_id, child_runtime_run_id,
           tool_call_id, host_run_id, state)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, runs.id, 'claimed'
         FROM brainstrike_assistant_thread_runs runs
         JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
         WHERE runs.id = $9 AND runs.resource_id = $2 AND runs.thread_id = $3
           AND runs.turn_message_id = $10 AND runs.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM brainstrike_assistant_thread_runs cancelled
             WHERE cancelled.resource_id = runs.resource_id AND cancelled.thread_id = runs.thread_id
               AND cancelled.turn_message_id = runs.turn_message_id AND cancelled.status IN ('cancelling', 'cancelled')
           )
           AND NOT EXISTS (
             SELECT 1 FROM brainstrike_delegated_invocations stopped
             JOIN jsonb_array_elements_text($11::jsonb) target(thread_id) ON target.thread_id = stopped.thread_id
             WHERE stopped.owner_resource_id = $2 AND stopped.root_thread_id = $3
               AND stopped.turn_message_id = $10 AND stopped.cancellation_requested_at IS NOT NULL
           )
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          id,
          scope.ownerResourceId,
          scope.rootThreadId,
          action.runId,
          action.toolCallId,
          leaf.threadId,
          leaf.identity.childRuntimeRunId,
          action.delegation.toolCallId,
          hostRunId,
          scope.turnMessageId,
          JSON.stringify(scopes.map((target) => target.threadId)),
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('tool-action-already-consumed-or-root-busy');
      }
      claims.add(id);
      claimedActionKey = toolActionKey(action);
    },
    continuation: createDesktopDelegatedContinuationHost(
      database,
      hostRunId,
      readScope,
      captureHistory,
      async (input) => {
        await host.resolveToolAction({
          continuationId: input.id,
          runId: input.nativeRunId,
          toolCallId: input.toolCallId,
          ...(input.delegation ? { delegation: input.delegation } : {}),
        });
      },
      subagentSettings
    ),
    async finishToolActions() {
      for (const id of claims) {
        const result = await database.query(
          `UPDATE brainstrike_delegated_tool_decisions SET state = 'consumed', finished_at = NOW()
           WHERE id = $1 AND host_run_id = $2 AND state = 'claimed' RETURNING id`,
          [id, hostRunId]
        );
        if (result.rows.length !== 1) {
          throw new DelegatedConversationIdentityError('tool-action-claim-lost');
        }
        claims.delete(id);
        claimedActionKey = undefined;
      }
    },
    async persist(identity) {
      if (!database.transaction) {
        throw new Error('Delegated admission requires the database transaction capability.');
      }
      const scope = await readScope();
      await database.transaction(async (tx) => {
        const admissionRepository = createDelegatedConversationRepository(tx);
        await admissionRepository.registerRoot(scope);
        const parent = await admissionRepository.get(scope, identity.parentThreadId);
        if (!parent || parent.resourceId !== identity.parentResourceId) {
          throw new DelegatedConversationIdentityError('parent-scope-mismatch');
        }
        const duplicate = await admissionRepository.getInvocation(scope, identity);
        await reserveDelegatedInvocation(
          tx,
          scope,
          hostRunId,
          identity.parentThreadId,
          duplicate !== null,
          identity.childThreadId,
          identity.configuration,
          subagentSettings
        );
        await admissionRepository.createChild(scope, {
          ...createDisplayIdentity(identity.childThreadId),
          configuration: identity.configuration,
          parentThreadId: identity.parentThreadId,
          resourceId: identity.childResourceId,
          threadId: identity.childThreadId,
        });
        await admissionRepository.createInvocation(scope, {
          hostRunId,
          ...(identity.originalToolCall ? { originalToolCall: identity.originalToolCall } : {}),
          parentRuntimeRunId: identity.parentRuntimeRunId,
          parentThreadId: identity.parentThreadId,
          parentToolCallId: identity.parentToolCallId,
          personaId: identity.personaId,
          threadId: identity.childThreadId,
        });
      });
      await captureWorkspaceStart?.(identity.childThreadId);
    },
    async persistEvent(identity, messageId, event, sequence) {
      const scope = await readScope();
      identityString.parse(messageId);
      // Opaque host-leg identity, never parsed for ancestry or authorization.
      const childRunId = delegatedHostRunId(hostRunId, identity);
      const persisted = {
        ...event,
        metadata:
          sanitizeAssistantRunEventMetadata({
            ...event.metadata,
            ...(event.kind.startsWith('subagent.')
              ? {
                  delegatedConversationIdentity: identity,
                  parentRuntimeRunId: identity.childRuntimeRunId,
                }
              : identity),
            nativeMessageId: messageId,
          }) ?? {},
        runId: childRunId,
        sequence,
      };
      await repository.recordInvocationEvent(scope, identity, hostRunId, persisted);
      return persisted;
    },
    async persistUsage(usage) {
      if (
        usage.source !== 'subagent' ||
        !isAssistantDelegatedUsageIdentity(usage.delegation) ||
        !usage.personaId?.trim()
      ) {
        throw new DelegatedConversationIdentityError('usage-identity-missing');
      }
      const scope = await readScope();
      await repository.recordInvocationUsage(
        scope,
        { ...usage.delegation, personaId: usage.personaId },
        {
          ...usage,
          ...usage.delegation,
          currentHostRunId: hostRunId,
          id: randomUUID(),
        }
      );
    },
    async prepareToolAction(action) {
      if (action.continuationId) {
        const scope = await readScope();
        await createDelegatedContinuationRepository(database, scope, hostRunId).assertDecisionClaim(
          {
            id: action.continuationId,
            nativeRunId: action.runId,
            toolCallId: action.toolCallId,
            ...(action.delegation ? { delegation: action.delegation } : {}),
          }
        );
      } else if (claims.size !== 1 || claimedActionKey !== toolActionKey(action)) {
        throw new DelegatedConversationIdentityError('history-requires-admission');
      }
      // Publish the boundary only when every ancestor read succeeds. A failed
      // preparation must not leave a mixture of old and newly captured history.
      const captured = await Promise.all(
        (await host.resolveToolAction(action)).map((scope) =>
          captureHistory(scope.threadId, scope.resourceId, false)
        )
      );
      for (const baseline of captured) {
        baselines.set(baseline.threadId, baseline);
      }
    },
    recordLiveDecision: (record) =>
      recordSwarmDiagnostic(hostRunId, 'live-decision', () =>
        recordLiveDecision(database, hostRunId, record)
      ),
    recordPromptManifest: (record) =>
      recordSwarmDiagnostic(hostRunId, 'prompt-manifest', () =>
        recordPromptManifest(database, hostRunId, record)
      ),
    async recordToolActionAnswer(action) {
      const scopes = await host.resolveToolAction(action);
      const leaf = scopes.at(-1);
      if (!leaf) {
        throw new DelegatedConversationIdentityError('tool-action-leaf-identity-required');
      }
      const scope = await readScope();
      // A policy answer is terminal the moment it is recorded: it joins the
      // ledger as `consumed` under this leg, never as the root's active claim
      // (one claimed decision per root is the serialization rule for USER
      // resumes across reconstructed runtimes). The same admission guards as a
      // claim apply, and the unique leaf key refuses a second answer.
      const result = await database.query(
        `INSERT INTO brainstrike_delegated_tool_decisions
          (id, owner_resource_id, root_thread_id, parent_runtime_run_id,
           parent_tool_call_id, child_thread_id, child_runtime_run_id,
           tool_call_id, host_run_id, state, finished_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, runs.id, 'consumed', NOW()
         FROM brainstrike_assistant_thread_runs runs
         JOIN mastra_threads root ON root.id = runs.thread_id AND root."resourceId" = runs.resource_id
         WHERE runs.id = $9 AND runs.resource_id = $2 AND runs.thread_id = $3
           AND runs.turn_message_id = $10 AND runs.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM brainstrike_assistant_thread_runs cancelled
             WHERE cancelled.resource_id = runs.resource_id AND cancelled.thread_id = runs.thread_id
               AND cancelled.turn_message_id = runs.turn_message_id AND cancelled.status IN ('cancelling', 'cancelled')
           )
           AND NOT EXISTS (
             SELECT 1 FROM brainstrike_delegated_invocations stopped
             JOIN jsonb_array_elements_text($11::jsonb) target(thread_id) ON target.thread_id = stopped.thread_id
             WHERE stopped.owner_resource_id = $2 AND stopped.root_thread_id = $3
               AND stopped.turn_message_id = $10 AND stopped.cancellation_requested_at IS NOT NULL
           )
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          randomUUID(),
          scope.ownerResourceId,
          scope.rootThreadId,
          action.runId,
          action.toolCallId,
          leaf.threadId,
          leaf.identity.childRuntimeRunId,
          action.delegation.toolCallId,
          hostRunId,
          scope.turnMessageId,
          JSON.stringify(scopes.map((target) => target.threadId)),
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('tool-action-already-consumed-or-root-busy');
      }
      // Freeze the child's history at the answer, as `prepareToolAction` does
      // for the claimed decision, so its resumed leg starts from a boundary.
      const captured = await Promise.all(
        scopes.map((target) => captureHistory(target.threadId, target.resourceId, false))
      );
      for (const baseline of captured) {
        baselines.set(baseline.threadId, baseline);
      }
    },
    recordWakeup: (record) =>
      recordSwarmDiagnostic(hostRunId, 'wakeup', () => recordWakeup(database, hostRunId, record)),
    async releaseUnexecutedToolAction(action) {
      const leaf = action.delegation?.path.at(-1);
      if (!(leaf && action.delegation && hasValidDelegatedToolActionTarget(action))) {
        throw new DelegatedConversationIdentityError('tool-action-path-invalid');
      }
      const claimedId = claims.values().next().value;
      if (!claimedId) {
        throw new DelegatedConversationIdentityError('tool-action-claim-lost');
      }
      // Only this binding's in-memory claim can be rolled back. A recreated
      // host, a different leaf, and a consumed/interrupted decision cannot.
      const result = await database.query(
        `DELETE FROM brainstrike_delegated_tool_decisions
         WHERE id = $1 AND host_run_id = $2 AND state = 'claimed'
           AND child_runtime_run_id = $3 AND tool_call_id = $4
           AND parent_runtime_run_id = $5 AND parent_tool_call_id = $6
         RETURNING id`,
        [
          claimedId,
          hostRunId,
          leaf.childRuntimeRunId,
          action.delegation.toolCallId,
          action.runId,
          action.toolCallId,
        ]
      );
      const released = z.object({ id: identityString }).safeParse(result.rows[0]);
      if (result.rows.length !== 1 || !released.success) {
        throw new DelegatedConversationIdentityError('tool-action-claim-lost');
      }
      claims.delete(released.data.id);
      claimedActionKey = undefined;
      baselines.clear();
      initialBaselines.clear();
    },
    async resolveParkedInvocation(parent) {
      // The same read-only discovery reload uses, bound to this leg's root.
      const scope = await readScope();
      return await createDesktopDelegatedSuspensionResolver(database, scope)(parent);
    },
    async resolveToolAction(action) {
      const scope = await readScope();
      if (!hasValidDelegatedToolActionTarget(action)) {
        throw new DelegatedConversationIdentityError('tool-action-path-invalid');
      }
      const rootInvocation = await repository.getInvocation(scope, {
        parentRuntimeRunId: action.runId,
        parentToolCallId: action.toolCallId,
      });
      if (!(rootInvocation || action.delegation)) {
        return [];
      }
      if (!rootInvocation) {
        throw new DelegatedConversationIdentityError('tool-action-invocation-missing');
      }
      if (!action.delegation) {
        throw new DelegatedConversationIdentityError('tool-action-leaf-identity-required');
      }
      const result: DelegatedToolActionScope[] = [];
      let parentThreadId = await resolveActionParentThreadId(database, scope, action);
      for (const edge of action.delegation.path) {
        const invocation = await repository.getInvocation(scope, edge);
        assertActionInvocation(invocation, edge, parentThreadId, scope.turnMessageId);
        const child = await repository.get(scope, invocation.threadId);
        if (!child) {
          throw new DelegatedConversationIdentityError('tool-action-conversation-missing');
        }
        result.push({
          configuration: child.configuration,
          identity: edge,
          ...(invocation.originalToolCall ? { originalToolCall: invocation.originalToolCall } : {}),
          resourceId: child.resourceId,
          threadId: child.threadId,
        });
        parentThreadId = child.threadId;
      }
      if (action.continuationId) {
        await assertDelegatedConversationAdmission(
          database,
          scope,
          result.map((child) => child.threadId)
        );
      }
      return result;
    },
    async sendFollowup(requestedScope, threadId, input, control) {
      const scope = await readScope();
      if (
        requestedScope.ownerResourceId !== scope.ownerResourceId ||
        requestedScope.rootThreadId !== scope.rootThreadId
      ) {
        throw new DelegatedConversationIdentityError('followup-root-owner-mismatch');
      }
      await assertDelegationRootRunning(database, scope, hostRunId);
      const target = followupTargets.get(threadId);
      const node = await repository.get(scope, threadId);
      if (!(target && node?.parentThreadId) || node.resourceId !== target.resourceId) {
        throw new DelegatedConversationIdentityError('followup-child-owner-unavailable');
      }
      await assertDelegatedConversationAdmission(database, scope, [threadId]);
      // The context the child is actually sent is captured when the control
      // prepares it, and recorded only once the control accepted the input: a
      // refused follow-up told the child nothing.
      const sent: { context?: { role: 'system'; content: string }[] } = {};
      await control(
        target,
        input,
        async () => {
          await assertDelegationRootRunning(database, scope, hostRunId);
          await assertDelegatedConversationAdmission(database, scope, [threadId]);
        },
        prepareInputContext
          ? async () => {
              sent.context = await prepareInputContext(input, node.configuration);
              return sent.context;
            }
          : undefined
      );
      const systemMessages = sent.context;
      if (systemMessages) {
        await recordSwarmDiagnostic(hostRunId, 'prompt-manifest', () =>
          recordPromptManifest(database, hostRunId, {
            delegationPrompt: input.text,
            kind: 'continuation',
            personaId: target.personaId,
            systemContextSource: systemMessages.length > 0 ? 'captured' : 'none',
            systemMessages,
            threadId,
            toolNames: readAdmittedPersonaConfiguration(node.configuration).allowedToolIds,
          })
        );
      }
    },
  };
  // Every function-valued member is wrapped by key, so a method added later
  // cannot escape unlogged. The members never use `this`; the detached
  // wrappers rely on that, and so must any future member.
  logIdentityRejections(hostRunId, host);
  logIdentityRejections(hostRunId, host.budget, 'budget.');
  logIdentityRejections(hostRunId, host.continuation, 'continuation.');
  return host;
}

/** Read-only discovery across turns; each edge still joins its original host and root owner. */
export function createDesktopDelegatedSuspensionResolver(
  database: DelegatedConversationDatabase,
  scope: { readonly ownerResourceId: string; readonly rootThreadId: string }
): DelegatedSuspensionResolver {
  const repository = createDelegatedConversationRepository(database);
  return async (parent) => {
    const invocation = await repository.getInvocation(scope, parent);
    if (!invocation) {
      return;
    }
    if (!invocation.childRuntimeRunId || invocation.parentThreadId !== parent.parentThreadId) {
      throw new DelegatedConversationIdentityError('suspended-invocation-ancestry-invalid');
    }
    const child = await repository.get(scope, invocation.threadId);
    if (!child) {
      throw new DelegatedConversationIdentityError('suspended-child-missing');
    }
    return {
      identity: {
        childRuntimeRunId: invocation.childRuntimeRunId,
        parentRuntimeRunId: invocation.parentRuntimeRunId,
        parentToolCallId: invocation.parentToolCallId,
        personaId: invocation.personaId,
      },
      resourceId: child.resourceId,
      threadId: child.threadId,
    };
  };
}
