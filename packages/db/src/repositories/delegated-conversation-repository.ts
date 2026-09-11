import {
  type AssistantRunEvent,
  type DelegatedOriginalToolCall,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract';
import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract/delegated-conversation-stream';

/**
 * Host-owned graph over native Mastra conversations. Write inputs come from
 * the host's observed delegation scope, never model arguments or renderer ids.
 * Read authorization joins the live root owner and exact native child scope.
 */
export interface DelegatedConversationDatabase {
  /** Only scalar SQL parameters and explicitly serialized configuration JSON. */
  query(sql: string, params?: (string | number | null)[]): Promise<{ rows: unknown[] }>;
  transaction?<T>(callback: (tx: DelegatedConversationDatabase) => Promise<T>): Promise<T>;
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface DelegatedConversationScope {
  readonly ownerResourceId: string;
  readonly rootThreadId: string;
}

export type DelegatedConversationColor = 'blue' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate';

export interface CreateDelegatedChild {
  readonly color: DelegatedConversationColor;
  readonly configuration: unknown;
  readonly displayName: string;
  readonly parentThreadId: string;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface DelegatedConversationNode extends DelegatedConversationScope {
  readonly color: DelegatedConversationColor | null;
  readonly configuration: JsonObject | null;
  readonly createdAt: Date;
  readonly displayName: string | null;
  readonly parentThreadId: string | null;
  readonly resourceId: string;
  readonly threadId: string;
  readonly workspaceRootId: string | null;
}

export interface DelegatedInvocationKey {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
}

export interface CreateDelegatedInvocation extends DelegatedInvocationKey {
  readonly hostRunId: string;
  readonly originalToolCall?: DelegatedOriginalToolCall;
  readonly parentThreadId: string;
  readonly personaId: string;
  readonly threadId: string;
}

export interface DelegatedInvocation extends CreateDelegatedInvocation, DelegatedConversationScope {
  readonly childRuntimeRunId: string | null;
  readonly turnMessageId: string;
}

export interface DelegatedInvocationUsage {
  readonly currentHostRunId: string;
  readonly id: string;
  readonly inputTokens: number;
  readonly model?: string;
  readonly outputTokens: number;
  readonly provider?: string;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface DelegatedConversationRepository {
  bindInvocationRun(
    scope: DelegatedConversationScope,
    key: DelegatedInvocationKey & { readonly personaId: string },
    childRuntimeRunId: string,
    currentHostRunId?: string
  ): Promise<DelegatedInvocation & { messageId?: string }>;

  /** Register the root first; write inputs must be observed by the trusted host. */
  createChild(
    scope: DelegatedConversationScope,
    child: CreateDelegatedChild
  ): Promise<DelegatedConversationNode>;
  createInvocation(
    scope: DelegatedConversationScope,
    invocation: CreateDelegatedInvocation
  ): Promise<DelegatedInvocation>;
  get(
    scope: DelegatedConversationScope,
    threadId: string
  ): Promise<DelegatedConversationNode | null>;
  getInvocation(
    scope: DelegatedConversationScope,
    key: DelegatedInvocationKey
  ): Promise<DelegatedInvocation | null>;
  listChildren(
    scope: DelegatedConversationScope,
    parentThreadId: string
  ): Promise<DelegatedConversationNode[]>;
  recordInvocationEvent(
    scope: DelegatedConversationScope,
    identity: DelegatedRunIdentity,
    currentHostRunId: string,
    event: AssistantRunEvent & { readonly runId: string; readonly sequence: number }
  ): Promise<void>;
  recordInvocationUsage(
    scope: DelegatedConversationScope,
    key: DelegatedInvocationKey & { readonly personaId: string },
    usage: DelegatedInvocationUsage
  ): Promise<void>;
  registerRoot(scope: DelegatedConversationScope): Promise<DelegatedConversationNode>;
}

export class DelegatedConversationIdentityError extends Error {
  readonly reason: string;
  constructor(reason = 'identity-conflict') {
    super(
      'Delegated conversation identity is missing, unauthorized or conflicts with its persisted binding.'
    );
    this.name = 'DelegatedConversationIdentityError';
    this.reason = reason;
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DelegatedConversationIdentityError();
  }
  return value;
}

function requireTokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DelegatedConversationIdentityError('invalid-token-count');
  }
  return value;
}

function requireColor(value: unknown): DelegatedConversationColor {
  if (
    value === 'blue' ||
    value === 'emerald' ||
    value === 'amber' ||
    value === 'rose' ||
    value === 'violet' ||
    value === 'slate'
  ) {
    return value;
  }
  throw new DelegatedConversationIdentityError();
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requireString(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
    return false;
  }
  const descriptors: PropertyDescriptor[] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Array.isArray(value) || key !== 'length') {
      descriptors.push(descriptor);
    }
  }
  // Holes and extra properties cannot survive a JSON round trip intact.
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      !Array.from(value.keys()).every((index) => Object.hasOwn(value, index)))
  ) {
    return false;
  }
  if (
    descriptors.some((descriptor) => !(descriptor.enumerable && Object.hasOwn(descriptor, 'value')))
  ) {
    return false;
  }
  ancestors.add(value);
  const valid = descriptors.every((descriptor) => isJsonValue(descriptor.value, ancestors));
  ancestors.delete(value);
  return valid;
}

function requireConfiguration(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new Error('Delegated configuration must be a finite, serializable JSON object.');
  }
  // Array.isArray does not narrow a readonly-array union in TypeScript.
  return value as JsonObject;
}

function readNode(value: unknown): DelegatedConversationNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DelegatedConversationIdentityError();
  }
  const row = value as Record<string, unknown>;
  const createdAt =
    row['created_at'] instanceof Date
      ? row['created_at']
      : new Date(requireString(row['created_at']));
  if (!Number.isFinite(createdAt.getTime())) {
    throw new DelegatedConversationIdentityError();
  }
  return {
    color: row['color'] === null ? null : requireColor(row['color']),
    configuration:
      row['configuration'] === null ? null : requireConfiguration(row['configuration']),
    createdAt,
    displayName: nullableString(row['display_name']),
    ownerResourceId: requireString(row['owner_resource_id']),
    parentThreadId: nullableString(row['parent_thread_id']),
    resourceId: requireString(row['resource_id']),
    rootThreadId: requireString(row['root_thread_id']),
    threadId: requireString(row['thread_id']),
    workspaceRootId: nullableString(row['workspace_root_id']),
  };
}

function readInvocation(value: unknown): DelegatedInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DelegatedConversationIdentityError();
  }
  const row = value as Record<string, unknown>;
  const rawToolCall = row['original_tool_call'];
  const originalToolCall =
    rawToolCall === null || rawToolCall === undefined
      ? undefined
      : readOriginalToolCall(rawToolCall);
  return {
    ...(originalToolCall ? { originalToolCall } : {}),
    childRuntimeRunId: nullableString(row['child_runtime_run_id']),
    hostRunId: requireString(row['host_run_id']),
    ownerResourceId: requireString(row['owner_resource_id']),
    parentRuntimeRunId: requireString(row['parent_runtime_run_id']),
    parentThreadId: requireString(row['parent_thread_id']),
    parentToolCallId: requireString(row['parent_tool_call_id']),
    personaId: requireString(row['persona_id']),
    rootThreadId: requireString(row['root_thread_id']),
    threadId: requireString(row['thread_id']),
    turnMessageId: requireString(row['turn_message_id']),
  };
}

function readOriginalToolCall(value: unknown): DelegatedOriginalToolCall {
  const parsed = requireConfiguration(value);
  if (Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'args')) {
    throw new DelegatedConversationIdentityError('invocation-input-invalid');
  }
  return { args: parsed['args'], toolName: requireString(parsed['toolName']) };
}

const TABLE = 'brainstrike_delegated_conversations';
// Walk outward from the authorized root. Checking only the requested node
// would leave grandchildren accessible after an intermediate scope changed.
const AUTHORIZED_GRAPH = `WITH RECURSIVE owned_nodes AS (
  SELECT node.* FROM ${TABLE} node
  JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
  WHERE node.owner_resource_id = $1 AND node.thread_id = $2
    AND node.root_thread_id = $2 AND node.parent_thread_id IS NULL
  UNION ALL
  SELECT node.* FROM ${TABLE} node
  JOIN owned_nodes parent ON node.parent_thread_id = parent.thread_id
  JOIN mastra_threads native ON native.id = node.thread_id AND native."resourceId" = node.resource_id
  WHERE node.owner_resource_id = $1 AND node.root_thread_id = $2
)`;

export function createDelegatedConversationRepository(
  database: DelegatedConversationDatabase
): DelegatedConversationRepository {
  function scopeParameters(scope: DelegatedConversationScope): string[] {
    return [requireString(scope.ownerResourceId), requireString(scope.rootThreadId)];
  }

  async function requireOwner(scope: DelegatedConversationScope): Promise<void> {
    const result = await database.query(
      'SELECT id FROM mastra_threads WHERE "resourceId" = $1 AND id = $2',
      scopeParameters(scope)
    );
    if (result.rows.length !== 1) {
      throw new DelegatedConversationIdentityError();
    }
  }

  function invocationParameters(
    scope: DelegatedConversationScope,
    key: DelegatedInvocationKey
  ): string[] {
    return [
      ...scopeParameters(scope),
      requireString(key.parentRuntimeRunId),
      requireString(key.parentToolCallId),
    ];
  }

  return {
    async bindInvocationRun(
      scope: DelegatedConversationScope,
      key: DelegatedInvocationKey & { readonly personaId: string },
      childRuntimeRunId: string,
      currentHostRunId?: string
    ): Promise<DelegatedInvocation & { messageId?: string }> {
      const result = await database.query(
        `${AUTHORIZED_GRAPH} UPDATE brainstrike_delegated_invocations invocation
         SET child_runtime_run_id = $5
         FROM owned_nodes child, brainstrike_assistant_thread_runs host,
           brainstrike_assistant_thread_runs current_leg
         WHERE host.id = invocation.host_run_id AND host.thread_id = $2
           AND host.resource_id = $1 AND host.turn_message_id = invocation.turn_message_id
           AND current_leg.id = COALESCE($7::text, invocation.host_run_id)
           AND current_leg.resource_id = $1 AND current_leg.thread_id = $2
           AND current_leg.turn_message_id = invocation.turn_message_id
           AND invocation.root_thread_id = $2 AND invocation.owner_resource_id = $1
           AND invocation.parent_runtime_run_id = $3 AND invocation.parent_tool_call_id = $4
           AND invocation.persona_id = $6
           AND invocation.thread_id = child.thread_id
           AND (invocation.child_runtime_run_id IS NULL OR invocation.child_runtime_run_id = $5)
         RETURNING invocation.*, child.parent_thread_id,
           (SELECT event.metadata->>'nativeMessageId'
            FROM brainstrike_assistant_run_events event
            JOIN brainstrike_assistant_thread_runs event_run ON event_run.id = event.run_id
            WHERE event.thread_id = invocation.thread_id
              AND event.metadata->>'childRuntimeRunId' = $5
              AND event.metadata->>'parentRuntimeRunId' = $3
              AND event.metadata->>'parentToolCallId' = $4
              AND event.metadata->>'personaId' = $6
              AND event.metadata->>'nativeMessageId' IS NOT NULL
            ORDER BY event_run.started_at DESC, event_run.created_at DESC, event_run.id DESC,
              event.sequence DESC
            LIMIT 1) AS native_message_id`,
        [
          ...invocationParameters(scope, key),
          requireString(childRuntimeRunId),
          requireString(key.personaId),
          currentHostRunId === undefined ? null : requireString(currentHostRunId),
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('invocation-binding-conflict');
      }
      const invocation = readInvocation(result.rows[0]);
      const messageId = nullableString(
        (result.rows[0] as Record<string, unknown>)['native_message_id']
      );
      return { ...invocation, ...(messageId ? { messageId } : {}) };
    },
    async createChild(
      scope: DelegatedConversationScope,
      child: CreateDelegatedChild
    ): Promise<DelegatedConversationNode> {
      const result = await database.query(
        `${AUTHORIZED_GRAPH} INSERT INTO ${TABLE}
        (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id,
          workspace_root_id, configuration, display_name, color)
        SELECT native.id, parent.owner_resource_id, parent.root_thread_id, parent.thread_id,
          native."resourceId",
          CASE WHEN parent.parent_thread_id IS NULL THEN native_parent.metadata->>'operatingRootId'
            ELSE parent.workspace_root_id END, $6::jsonb, $7, $8
        FROM owned_nodes parent
        JOIN mastra_threads native_parent ON native_parent.id = parent.thread_id
        JOIN mastra_threads native ON native.id = $4 AND native."resourceId" = $5
        WHERE parent.owner_resource_id = $1 AND parent.root_thread_id = $2 AND parent.thread_id = $3
          AND (parent.parent_thread_id IS NOT NULL OR native_parent.metadata->'operatingRootId' IS NULL
            OR jsonb_typeof(native_parent.metadata->'operatingRootId') = 'null'
            OR (jsonb_typeof(native_parent.metadata->'operatingRootId') = 'string'
              AND length(btrim(native_parent.metadata->>'operatingRootId')) > 0))
        ON CONFLICT (thread_id) DO UPDATE SET thread_id = EXCLUDED.thread_id
        WHERE ${TABLE}.owner_resource_id = EXCLUDED.owner_resource_id
          AND ${TABLE}.root_thread_id = EXCLUDED.root_thread_id
          AND ${TABLE}.parent_thread_id = EXCLUDED.parent_thread_id
          AND ${TABLE}.resource_id = EXCLUDED.resource_id
          AND ${TABLE}.configuration = EXCLUDED.configuration
          AND ${TABLE}.display_name = EXCLUDED.display_name
          AND ${TABLE}.color = EXCLUDED.color
        RETURNING *`,
        [
          ...scopeParameters(scope),
          requireString(child.parentThreadId),
          requireString(child.threadId),
          requireString(child.resourceId),
          JSON.stringify(requireConfiguration(child.configuration)),
          requireString(child.displayName),
          requireColor(child.color),
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError();
      }
      return readNode(result.rows[0]);
    },
    async createInvocation(
      scope: DelegatedConversationScope,
      invocation: CreateDelegatedInvocation
    ): Promise<DelegatedInvocation> {
      const result = await database.query(
        `${AUTHORIZED_GRAPH}, inserted AS (
         INSERT INTO brainstrike_delegated_invocations
           (owner_resource_id, root_thread_id, thread_id, host_run_id, turn_message_id,
            parent_runtime_run_id, parent_tool_call_id, persona_id, original_tool_call)
         SELECT child.owner_resource_id, child.root_thread_id, child.thread_id, host.id,
           host.turn_message_id, $3, $4, $8, $9::jsonb
         FROM owned_nodes child
         JOIN brainstrike_assistant_thread_runs host ON host.id = $7
           AND host.resource_id = $1 AND host.thread_id = $2
         WHERE child.thread_id = $5 AND child.parent_thread_id = $6
           AND length(btrim(host.turn_message_id)) > 0
         ON CONFLICT (root_thread_id, parent_runtime_run_id, parent_tool_call_id)
         DO UPDATE SET thread_id = EXCLUDED.thread_id
         WHERE brainstrike_delegated_invocations.owner_resource_id = EXCLUDED.owner_resource_id
           AND brainstrike_delegated_invocations.thread_id = EXCLUDED.thread_id
           AND brainstrike_delegated_invocations.host_run_id = EXCLUDED.host_run_id
           AND brainstrike_delegated_invocations.turn_message_id = EXCLUDED.turn_message_id
           AND brainstrike_delegated_invocations.persona_id = EXCLUDED.persona_id
           AND brainstrike_delegated_invocations.original_tool_call IS NOT DISTINCT FROM EXCLUDED.original_tool_call
         RETURNING *)
         SELECT inserted.*, child.parent_thread_id FROM inserted
         JOIN owned_nodes child ON child.thread_id = inserted.thread_id`,
        [
          ...invocationParameters(scope, invocation),
          requireString(invocation.threadId),
          requireString(invocation.parentThreadId),
          requireString(invocation.hostRunId),
          requireString(invocation.personaId),
          invocation.originalToolCall
            ? JSON.stringify(readOriginalToolCall(invocation.originalToolCall))
            : null,
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('invocation-binding-conflict');
      }
      return readInvocation(result.rows[0]);
    },

    async get(
      scope: DelegatedConversationScope,
      threadId: string
    ): Promise<DelegatedConversationNode | null> {
      await requireOwner(scope);
      const result = await database.query(
        `${AUTHORIZED_GRAPH} SELECT * FROM owned_nodes WHERE thread_id = $3`,
        [...scopeParameters(scope), requireString(threadId)]
      );
      return result.rows.length === 0 ? null : readNode(result.rows[0]);
    },
    async getInvocation(
      scope: DelegatedConversationScope,
      key: DelegatedInvocationKey
    ): Promise<DelegatedInvocation | null> {
      await requireOwner(scope);
      const result = await database.query(
        `${AUTHORIZED_GRAPH} SELECT invocation.*, child.parent_thread_id
         FROM brainstrike_delegated_invocations invocation
         JOIN owned_nodes child ON child.thread_id = invocation.thread_id
         JOIN brainstrike_assistant_thread_runs host ON host.id = invocation.host_run_id
           AND host.thread_id = $2 AND host.resource_id = $1
           AND host.turn_message_id = invocation.turn_message_id
         WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
           AND invocation.parent_runtime_run_id = $3 AND invocation.parent_tool_call_id = $4`,
        invocationParameters(scope, key)
      );
      return result.rows.length === 0 ? null : readInvocation(result.rows[0]);
    },

    async listChildren(
      scope: DelegatedConversationScope,
      parentThreadId: string
    ): Promise<DelegatedConversationNode[]> {
      await requireOwner(scope);
      const result = await database.query(
        `${AUTHORIZED_GRAPH} SELECT * FROM owned_nodes WHERE parent_thread_id = $3
        ORDER BY created_at, thread_id`,
        [...scopeParameters(scope), requireString(parentThreadId)]
      );
      return result.rows.map(readNode);
    },
    async recordInvocationEvent(scope, identity, currentHostRunId, event) {
      const terminalStatus =
        event.kind === 'run.finished'
          ? 'completed'
          : event.kind === 'run.cancelled'
            ? 'cancelled'
            : event.kind === 'run.failed'
              ? 'failed'
              : null;
      const result = await database.query(
        `${AUTHORIZED_GRAPH}, authorized AS (
          SELECT child.*, original.provider, original.model, original.runtime_kind
          FROM brainstrike_delegated_invocations invocation
          JOIN owned_nodes child ON child.thread_id = invocation.thread_id
          JOIN brainstrike_assistant_thread_runs original ON original.id = invocation.host_run_id
            AND original.resource_id = $1 AND original.thread_id = $2
            AND original.turn_message_id = invocation.turn_message_id
          JOIN brainstrike_assistant_thread_runs current_leg ON current_leg.id = $7
            AND current_leg.resource_id = $1 AND current_leg.thread_id = $2
            AND current_leg.turn_message_id = invocation.turn_message_id
          WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
            AND invocation.parent_runtime_run_id = $3 AND invocation.parent_tool_call_id = $4
            AND invocation.child_runtime_run_id = $5 AND invocation.persona_id = $6
            AND (child.configuration #> '{persona,model}' IS NULL OR (
              jsonb_typeof(child.configuration #> '{persona,model,provider}') = 'string'
              AND length(btrim(child.configuration #>> '{persona,model,provider}')) > 0
              AND jsonb_typeof(child.configuration #> '{persona,model,modelId}') = 'string'
              AND length(btrim(child.configuration #>> '{persona,model,modelId}')) > 0))
            AND NOT EXISTS (SELECT 1 FROM brainstrike_assistant_run_events prior
              WHERE prior.id = $9 AND ROW(prior.run_id, prior.resource_id, prior.thread_id,
                prior.sequence, prior.kind, prior.status, prior.label, prior.detail,
                prior.metadata, prior.occurred_at, prior.duration_ms) IS DISTINCT FROM
                ROW($8::text, child.resource_id, child.thread_id, $10::integer, $11::text,
                  $12::text, $13::text, $14::text, $15::jsonb, $16::timestamptz, $17::integer))
        ), child_run AS (
          INSERT INTO brainstrike_assistant_thread_runs AS stored
            (id, resource_id, thread_id, provider, model, runtime_kind, status,
             started_at, completed_at, created_at, updated_at)
          SELECT $8, resource_id, thread_id,
            COALESCE(configuration #>> '{persona,model,provider}', provider),
            COALESCE(configuration #>> '{persona,model,modelId}', model), runtime_kind,
            COALESCE($18::text, 'running'), $16::timestamptz,
            CASE WHEN $18::text IS NOT NULL THEN $16::timestamptz END, NOW(), NOW()
          FROM authorized
          ON CONFLICT (id) DO UPDATE SET
            status = COALESCE($18::text, stored.status),
            completed_at = CASE WHEN $18::text IS NOT NULL THEN $16::timestamptz ELSE stored.completed_at END,
            updated_at = NOW()
          WHERE stored.thread_id = EXCLUDED.thread_id AND stored.resource_id = EXCLUDED.resource_id
            AND stored.provider = EXCLUDED.provider AND stored.model = EXCLUDED.model
            AND stored.runtime_kind = EXCLUDED.runtime_kind
            AND ($18::text IS NULL OR stored.status = 'running' OR stored.status = $18)
          RETURNING *
        ) INSERT INTO brainstrike_assistant_run_events AS stored
          (id, run_id, resource_id, thread_id, sequence, kind, status, label, detail,
           metadata, occurred_at, duration_ms, created_at, updated_at)
          SELECT $9, id, resource_id, thread_id, $10::integer, $11, $12, $13, $14,
            $15::jsonb, $16::timestamptz, $17::integer, NOW(), NOW() FROM child_run
          ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
          WHERE stored.run_id = EXCLUDED.run_id AND stored.resource_id = EXCLUDED.resource_id
            AND stored.thread_id = EXCLUDED.thread_id AND stored.sequence = EXCLUDED.sequence
            AND stored.kind = EXCLUDED.kind AND stored.status = EXCLUDED.status
            AND stored.label = EXCLUDED.label AND stored.detail IS NOT DISTINCT FROM EXCLUDED.detail
            AND stored.metadata IS NOT DISTINCT FROM EXCLUDED.metadata
            AND stored.occurred_at = EXCLUDED.occurred_at
            AND stored.duration_ms IS NOT DISTINCT FROM EXCLUDED.duration_ms
          RETURNING id`,
        [
          ...invocationParameters(scope, identity),
          requireString(identity.childRuntimeRunId),
          requireString(identity.personaId),
          requireString(currentHostRunId),
          requireString(event.runId),
          requireString(event.id),
          requireTokenCount(event.sequence),
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          JSON.stringify(sanitizeAssistantRunEventMetadata(event.metadata) ?? {}),
          event.timestamp,
          event.durationMs ?? null,
          terminalStatus,
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('event-binding-conflict');
      }
    },
    async recordInvocationUsage(scope, key, usage) {
      const result = await database.query(
        `${AUTHORIZED_GRAPH} INSERT INTO brainstrike_assistant_run_usage AS stored
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens,
           run_kind, delegation_parent_run_id, delegation_tool_call_id)
         SELECT $5, invocation.root_thread_id, invocation.host_run_id, invocation.owner_resource_id,
           COALESCE($10, original.model), COALESCE($11, original.provider), $12::integer, $13::integer,
           'subagent', invocation.parent_runtime_run_id, invocation.parent_tool_call_id
         FROM brainstrike_delegated_invocations invocation
         JOIN owned_nodes child ON child.thread_id = invocation.thread_id
         JOIN brainstrike_assistant_thread_runs original ON original.id = invocation.host_run_id
           AND original.resource_id = $1 AND original.thread_id = $2
           AND original.turn_message_id = invocation.turn_message_id
         JOIN brainstrike_assistant_thread_runs current_leg ON current_leg.id = $6
           AND current_leg.resource_id = $1 AND current_leg.thread_id = $2
           AND current_leg.turn_message_id = invocation.turn_message_id
         WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
           AND invocation.parent_runtime_run_id = $3 AND invocation.parent_tool_call_id = $4
           AND invocation.thread_id = $7 AND invocation.persona_id = $8
           AND invocation.child_runtime_run_id IS NOT NULL AND child.resource_id = $9
         ON CONFLICT (thread_id, delegation_parent_run_id, delegation_tool_call_id)
         DO UPDATE SET input_tokens = GREATEST(stored.input_tokens, EXCLUDED.input_tokens),
           output_tokens = GREATEST(stored.output_tokens, EXCLUDED.output_tokens)
         WHERE stored.run_id = EXCLUDED.run_id AND stored.resource_id = EXCLUDED.resource_id
           AND stored.model = EXCLUDED.model AND stored.provider = EXCLUDED.provider
         RETURNING id`,
        [
          ...invocationParameters(scope, key),
          requireString(usage.id),
          requireString(usage.currentHostRunId),
          requireString(usage.threadId),
          requireString(key.personaId),
          requireString(usage.resourceId),
          usage.model === undefined ? null : requireString(usage.model),
          usage.provider === undefined ? null : requireString(usage.provider),
          requireTokenCount(usage.inputTokens),
          requireTokenCount(usage.outputTokens),
        ]
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError('usage-binding-conflict');
      }
    },
    async registerRoot(scope: DelegatedConversationScope): Promise<DelegatedConversationNode> {
      const result = await database.query(
        `INSERT INTO ${TABLE}
        (thread_id, owner_resource_id, root_thread_id, resource_id)
        SELECT id, "resourceId", id, "resourceId"
        FROM mastra_threads WHERE "resourceId" = $1 AND id = $2
        ON CONFLICT (thread_id) DO UPDATE SET thread_id = EXCLUDED.thread_id
        WHERE ${TABLE}.owner_resource_id = EXCLUDED.owner_resource_id
          AND ${TABLE}.root_thread_id = EXCLUDED.root_thread_id
          AND ${TABLE}.parent_thread_id IS NULL
        RETURNING *`,
        scopeParameters(scope)
      );
      if (result.rows.length !== 1) {
        throw new DelegatedConversationIdentityError();
      }
      return readNode(result.rows[0]);
    },
  };
}
