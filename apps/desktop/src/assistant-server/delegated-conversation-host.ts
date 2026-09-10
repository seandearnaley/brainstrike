import { createHash, randomUUID } from 'node:crypto';
import type {
  DelegatedConversationBinding,
  DelegatedConversationIdentity,
  DelegatedRunIdentity,
  DelegatedSuspensionResolver,
  DelegatedToolActionScope,
} from '@brainstrike/agent';
import type { DelegatedConversationBaseline } from '@brainstrike/assistant-contract';
import { hasValidDelegatedToolActionTarget } from '@brainstrike/assistant-contract';
import {
  type AssistantRunEvent,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import {
  type AssistantChildRunUsage,
  isAssistantDelegatedUsageIdentity,
} from '@brainstrike/assistant-contract/run-usage';
import {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  createDelegatedConversationRepository,
  type DelegatedConversationColor,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedInvocation,
  readAssistantHistoryMessages,
  readAssistantHistoryRunEvents,
} from '@brainstrike/db';
import { z } from 'zod';

const identityString = z.string().refine((value) => value.trim().length > 0);
const hostScopeSchema = z.object({
  ownerResourceId: identityString,
  rootThreadId: identityString,
  turnMessageId: identityString,
});

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
    action.delegation?.toolCallId,
    action.delegation?.path.map((edge) => [
      edge.parentRuntimeRunId,
      edge.parentToolCallId,
      edge.childRuntimeRunId,
      edge.personaId,
    ]),
  ]);
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
 * Per-host-leg authority. Native resource ids are execution scopes; the owner
 * and originating turn come exclusively from the server's persisted run row.
 * Recreated resume legs authorize the original invocation without replacing it.
 */
export function createDesktopDelegatedConversationHost(
  database: DelegatedConversationDatabase,
  hostRunId: string
): {
  bindRun(identity: DelegatedRunIdentity): Promise<{
    readonly threadId: string;
    readonly messageId?: string;
    readonly baseline?: DelegatedConversationBaseline;
  }>;
  resolveToolAction: NonNullable<DelegatedConversationBinding['resolveToolAction']>;
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
  const baselines = new Map<string, DelegatedConversationBaseline>();
  const initialBaselines = new Map<string, Promise<DelegatedConversationBaseline>>();
  const captureHistory = async (
    threadId: string,
    resourceId: string,
    initial: boolean
  ): Promise<DelegatedConversationBaseline> => {
    const [messages, runEvents] = await Promise.all([
      readAssistantHistoryMessages(database, threadId, resourceId, {
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
    return structuredClone({
      hostRunId,
      // Mastra generates a fresh child thread per delegation invocation. Native
      // input rows are history; this invocation's output belongs to its decoder.
      messages: history,
      runEvents: initial ? [] : [...runEvents],
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
      return {
        threadId: invocation.threadId,
        ...(baseline ? { baseline } : {}),
        ...(invocation.messageId ? { messageId: invocation.messageId } : {}),
      };
    },
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
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('tool-action-already-consumed-or-root-busy');
      }
      claims.add(id);
      claimedActionKey = toolActionKey(action);
    },
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
      const scope = await readScope();
      await repository.registerRoot(scope);
      const parent = await repository.get(scope, identity.parentThreadId);
      if (!parent || parent.resourceId !== identity.parentResourceId) {
        throw new DelegatedConversationIdentityError('parent-scope-mismatch');
      }
      await repository.createChild(scope, {
        ...createDisplayIdentity(identity.childThreadId),
        configuration: identity.configuration,
        parentThreadId: identity.parentThreadId,
        resourceId: identity.childResourceId,
        threadId: identity.childThreadId,
      });
      await repository.createInvocation(scope, {
        hostRunId,
        ...(identity.originalToolCall ? { originalToolCall: identity.originalToolCall } : {}),
        parentRuntimeRunId: identity.parentRuntimeRunId,
        parentThreadId: identity.parentThreadId,
        parentToolCallId: identity.parentToolCallId,
        personaId: identity.personaId,
        threadId: identity.childThreadId,
      });
    },
    async persistEvent(identity, messageId, event, sequence) {
      const scope = await readScope();
      identityString.parse(messageId);
      // Opaque host-leg identity, never parsed for ancestry or authorization.
      const childRunId = `delegated-run-${createHash('sha256')
        .update(
          JSON.stringify([
            hostRunId,
            identity.parentRuntimeRunId,
            identity.parentToolCallId,
            identity.childRuntimeRunId,
          ])
        )
        .digest('hex')}`;
      const persisted = {
        ...event,
        metadata:
          sanitizeAssistantRunEventMetadata({
            ...event.metadata,
            ...identity,
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
      if (claims.size !== 1 || claimedActionKey !== toolActionKey(action)) {
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
      let parentThreadId = scope.rootThreadId;
      for (const edge of action.delegation.path) {
        const invocation = await repository.getInvocation(scope, edge);
        assertActionInvocation(invocation, edge, parentThreadId, scope.turnMessageId);
        const child = await repository.get(scope, invocation.threadId);
        if (!child) {
          throw new DelegatedConversationIdentityError('tool-action-conversation-missing');
        }
        result.push({
          identity: edge,
          ...(invocation.originalToolCall ? { originalToolCall: invocation.originalToolCall } : {}),
          resourceId: child.resourceId,
          threadId: child.threadId,
        });
        parentThreadId = child.threadId;
      }
      return result;
    },
  };
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
