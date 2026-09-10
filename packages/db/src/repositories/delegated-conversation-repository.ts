/**
 * Host-owned graph over native Mastra conversations. Write inputs come from
 * the host's observed delegation scope, never model arguments or renderer ids.
 * Read authorization joins the live root owner and exact native child scope.
 */
export interface DelegatedConversationDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
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

export interface DelegatedConversationRepository {
  /** Register the root first; write inputs must be observed by the trusted host. */
  createChild(
    scope: DelegatedConversationScope,
    child: CreateDelegatedChild
  ): Promise<DelegatedConversationNode>;
  get(
    scope: DelegatedConversationScope,
    threadId: string
  ): Promise<DelegatedConversationNode | null>;
  listChildren(
    scope: DelegatedConversationScope,
    parentThreadId: string
  ): Promise<DelegatedConversationNode[]>;
  registerRoot(scope: DelegatedConversationScope): Promise<DelegatedConversationNode>;
}

export class DelegatedConversationIdentityError extends Error {
  constructor() {
    super(
      'Delegated conversation identity is missing, unauthorized or conflicts with its persisted binding.'
    );
    this.name = 'DelegatedConversationIdentityError';
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DelegatedConversationIdentityError();
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

  return {
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
