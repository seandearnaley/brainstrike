import type { DbHandle } from '@brainstrike/db';
import {
  ASSISTANT_THREAD_COLOR_IDS,
  type AssistantThreadColorId,
} from './assistant-memory-repository';

/**
 * User-defined thread groups (folders) for the Threads panel.
 *
 * Groups and placements live in Brainstrike-owned tables (migration 054) — NOT
 * in `mastra_threads.metadata`, whose updates bump the thread's `updatedAt` and
 * would reshuffle the panel's recency sort on every drag. A placement row whose
 * thread no longer exists is inert: the panel joins placements to loaded
 * threads by id. `rank` values are fractional-index keys (`fractional-indexing`
 * `generateKeyBetween`), lexicographically ordered as text.
 */
export interface AssistantThreadGroup {
  readonly color: AssistantThreadColorId | null;
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly resourceId: string;
}

export interface AssistantThreadPlacement {
  readonly flatRank: string | null;
  readonly groupId: string | null;
  readonly rank: string;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface AssistantThreadGroupRankEntry {
  readonly groupId: string;
  readonly rank: string;
}

export interface AssistantThreadGroupsRepository {
  clearThreadPlacement: (threadId: string) => Promise<void>;
  createGroup: (resourceId: string, name: string, rank: string) => Promise<AssistantThreadGroup>;
  deleteGroup: (groupId: string) => Promise<void>;
  listGroups: (resourceId: string) => Promise<readonly AssistantThreadGroup[]>;
  listPlacements: (resourceId: string) => Promise<readonly AssistantThreadPlacement[]>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  setGroupColor: (groupId: string, color: AssistantThreadColorId | null) => Promise<void>;
  setGroupRank: (groupId: string, rank: string) => Promise<void>;
  setGroupRanks: (entries: readonly AssistantThreadGroupRankEntry[]) => Promise<void>;
  setThreadPlacement: (placement: AssistantThreadPlacement) => Promise<void>;
  setThreadPlacements: (placements: readonly AssistantThreadPlacement[]) => Promise<void>;
}

const GROUPS_TABLE = 'brainstrike_assistant_thread_groups';
const PLACEMENTS_TABLE = 'brainstrike_assistant_thread_placements';

const repositoryCache = new WeakMap<DbHandle, AssistantThreadGroupsRepository>();
const ASSISTANT_THREAD_COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);

function createThreadGroupId(): string {
  return `thread-group-${crypto.randomUUID()}`;
}

function requireGroupName(name: string): string {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Thread group name is required.');
  }
  return normalizedName;
}

function requireRank(rank: string, subject: 'group' | 'placement'): string {
  if (!rank.trim()) {
    throw new Error(
      subject === 'group' ? 'Thread group rank is required.' : 'Thread placement rank is required.'
    );
  }
  return rank;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid thread group row: ${fieldName} is not a string.`);
  }
  return value;
}

function requireNullableGroupColor(value: unknown): AssistantThreadColorId | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && ASSISTANT_THREAD_COLOR_ID_SET.has(value)) {
    return value as AssistantThreadColorId;
  }
  throw new Error('Invalid thread group row: color is not a supported color or null.');
}

function requireNullableRank(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  throw new Error(`Invalid thread group row: ${fieldName} is not a non-empty string or null.`);
}

function requireGroupColor(color: AssistantThreadColorId | null): void {
  if (color !== null && !ASSISTANT_THREAD_COLOR_ID_SET.has(color)) {
    throw new Error('Invalid thread group color.');
  }
}

function toGroup(row: Record<string, unknown>): AssistantThreadGroup {
  return {
    color: requireNullableGroupColor(row['color']),
    id: requireString(row['id'], 'id'),
    name: requireString(row['name'], 'name'),
    rank: requireString(row['rank'], 'rank'),
    resourceId: requireString(row['resourceId'], 'resourceId'),
  };
}

function toPlacement(row: Record<string, unknown>): AssistantThreadPlacement {
  const groupId = row['groupId'];
  return {
    flatRank: requireNullableRank(row['flatRank'], 'flatRank'),
    groupId: groupId === null || groupId === undefined ? null : requireString(groupId, 'groupId'),
    rank: requireString(row['rank'], 'rank'),
    resourceId: requireString(row['resourceId'], 'resourceId'),
    threadId: requireString(row['threadId'], 'threadId'),
  };
}

export function createPgliteAssistantThreadGroupsRepository(
  database: DbHandle
): AssistantThreadGroupsRepository {
  const cachedRepository = repositoryCache.get(database);
  if (cachedRepository) {
    return cachedRepository;
  }

  const repository: AssistantThreadGroupsRepository = {
    async clearThreadPlacement(threadId: string): Promise<void> {
      await database.query(`DELETE FROM ${PLACEMENTS_TABLE} WHERE thread_id = $1`, [threadId]);
    },
    async createGroup(
      resourceId: string,
      name: string,
      rank: string
    ): Promise<AssistantThreadGroup> {
      const normalizedName = requireGroupName(name);
      requireRank(rank, 'group');
      const group: AssistantThreadGroup = {
        color: null,
        id: createThreadGroupId(),
        name: normalizedName,
        rank,
        resourceId,
      };
      await database.query(
        `INSERT INTO ${GROUPS_TABLE} (id, resource_id, name, rank, color)
         VALUES ($1, $2, $3, $4, NULL)`,
        [group.id, group.resourceId, group.name, group.rank]
      );
      return group;
    },
    async deleteGroup(groupId: string): Promise<void> {
      // Placements first: threads return to Ungrouped even if the group DELETE
      // fails and is retried.
      await database.query(`DELETE FROM ${PLACEMENTS_TABLE} WHERE group_id = $1`, [groupId]);
      await database.query(`DELETE FROM ${GROUPS_TABLE} WHERE id = $1`, [groupId]);
    },
    async listGroups(resourceId: string): Promise<readonly AssistantThreadGroup[]> {
      const result = await database.query<Record<string, unknown>>(
        `SELECT id, resource_id AS "resourceId", name, rank, color
         FROM ${GROUPS_TABLE}
         WHERE resource_id = $1
         ORDER BY rank ASC, id ASC`,
        [resourceId]
      );
      return result.rows.map(toGroup);
    },
    async listPlacements(resourceId: string): Promise<readonly AssistantThreadPlacement[]> {
      const result = await database.query<Record<string, unknown>>(
        `SELECT thread_id AS "threadId", resource_id AS "resourceId",
                group_id AS "groupId", rank, flat_rank AS "flatRank"
         FROM ${PLACEMENTS_TABLE}
         WHERE resource_id = $1`,
        [resourceId]
      );
      return result.rows.map(toPlacement);
    },
    async renameGroup(groupId: string, name: string): Promise<void> {
      const normalizedName = requireGroupName(name);
      await database.query(
        `UPDATE ${GROUPS_TABLE} SET name = $2, updated_at = NOW() WHERE id = $1`,
        [groupId, normalizedName]
      );
    },
    async setGroupColor(groupId: string, color: AssistantThreadColorId | null): Promise<void> {
      requireGroupColor(color);
      await database.query(
        `UPDATE ${GROUPS_TABLE} SET color = $2, updated_at = NOW() WHERE id = $1`,
        [groupId, color]
      );
    },
    async setGroupRank(groupId: string, rank: string): Promise<void> {
      requireRank(rank, 'group');
      await database.query(
        `UPDATE ${GROUPS_TABLE} SET rank = $2, updated_at = NOW() WHERE id = $1`,
        [groupId, rank]
      );
    },
    async setGroupRanks(entries: readonly AssistantThreadGroupRankEntry[]): Promise<void> {
      if (entries.length === 0) {
        return;
      }
      for (const entry of entries) {
        requireRank(entry.rank, 'group');
      }
      // One statement so the whole reorder is atomic — a partial failure can
      // never leave half the groups on fresh ranks.
      const valueRows = entries
        .map((_, index) => `($${2 * index + 1}, $${2 * index + 2})`)
        .join(', ');
      await database.query(
        `UPDATE ${GROUPS_TABLE} AS groups
         SET rank = ranked.rank, updated_at = NOW()
         FROM (VALUES ${valueRows}) AS ranked(id, rank)
         WHERE groups.id = ranked.id`,
        entries.flatMap((entry) => [entry.groupId, entry.rank])
      );
    },
    async setThreadPlacement(placement: AssistantThreadPlacement): Promise<void> {
      await repository.setThreadPlacements([placement]);
    },
    async setThreadPlacements(placements: readonly AssistantThreadPlacement[]): Promise<void> {
      if (placements.length === 0) {
        return;
      }
      for (const placement of placements) {
        requireRank(placement.rank, 'placement');
        requireNullableRank(placement.flatRank, 'flatRank');
      }
      // Single multi-row upsert: atomic without needing the optional
      // DbHandle.transaction capability, and one round trip per drop.
      const valueRows = placements
        .map((_, index) => {
          const offset = 5 * index;
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
        })
        .join(', ');
      await database.query(
        `INSERT INTO ${PLACEMENTS_TABLE} (thread_id, resource_id, group_id, rank, flat_rank)
         VALUES ${valueRows}
         ON CONFLICT (thread_id) DO UPDATE
           SET resource_id = EXCLUDED.resource_id,
               group_id = EXCLUDED.group_id,
               rank = EXCLUDED.rank,
               flat_rank = EXCLUDED.flat_rank,
               updated_at = NOW()`,
        placements.flatMap((placement) => [
          placement.threadId,
          placement.resourceId,
          placement.groupId,
          placement.rank,
          placement.flatRank,
        ])
      );
    },
  };

  repositoryCache.set(database, repository);
  return repository;
}
