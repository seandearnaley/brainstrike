import { createHash, randomUUID } from 'node:crypto';
import type { DelegatedConversationIdentity, DelegatedRunIdentity } from '@brainstrike/agent';
import type { AssistantRunEvent } from '@brainstrike/assistant-contract/run-events';
import {
  type AssistantChildRunUsage,
  isAssistantDelegatedUsageIdentity,
} from '@brainstrike/assistant-contract/run-usage';
import {
  createDelegatedConversationRepository,
  type DelegatedConversationColor,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
} from '@brainstrike/db';
import { z } from 'zod';

const identityString = z.string().refine((value) => value.trim().length > 0);
const hostScopeSchema = z.object({
  ownerResourceId: identityString,
  rootThreadId: identityString,
  turnMessageId: identityString,
});

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
  bindRun(identity: DelegatedRunIdentity): Promise<void>;
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
  return {
    async bindRun(identity) {
      const scope = await readScope();
      await repository.bindInvocationRun(scope, identity, identity.childRuntimeRunId, hostRunId);
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
        metadata: { ...event.metadata, ...identity, nativeMessageId: messageId },
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
  };
}
