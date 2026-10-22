/**
 * User-defined thread groups (folders) for the Threads panel.
 *
 * Groups and placements live in Brainstrike-owned tables (migrations 054, 056,
 * and 059) — NOT in `mastra_threads.metadata`, because grouping, group identity,
 * and manual order are Brainstrike-owned presentation state. A placement row whose
 * thread no longer exists is inert: the panel joins placements to loaded
 * threads by id. `rank` values are fractional-index keys (`fractional-indexing`
 * `generateKeyBetween`), lexicographically ordered as text.
 */
import type {
  AssistantThreadGroup,
  AssistantThreadGroupRankEntry,
  AssistantThreadPlacement,
} from '@brainstrike/types';
import type { AssistantThreadColorId, AssistantThreadIconId } from './assistant-memory-repository';

export type {
  AssistantThreadGroup,
  AssistantThreadGroupRankEntry,
  AssistantThreadPlacement,
} from '@brainstrike/types';

export interface AssistantThreadGroupsRepository {
  clearThreadPlacement: (threadId: string) => Promise<void>;
  clearThreadPlacements: (threadIds: readonly string[]) => Promise<void>;
  createGroup: (resourceId: string, name: string, rank: string) => Promise<AssistantThreadGroup>;
  deleteGroup: (groupId: string) => Promise<void>;
  listGroups: (resourceId: string) => Promise<readonly AssistantThreadGroup[]>;
  listPlacements: (resourceId: string) => Promise<readonly AssistantThreadPlacement[]>;
  renameGroup: (groupId: string, name: string) => Promise<void>;
  setGroupColor: (groupId: string, color: AssistantThreadColorId | null) => Promise<void>;
  setGroupIcon: (groupId: string, icon: AssistantThreadIconId | null) => Promise<void>;
  setGroupRank: (groupId: string, rank: string) => Promise<void>;
  setGroupRanks: (entries: readonly AssistantThreadGroupRankEntry[]) => Promise<void>;
  setThreadPlacement: (placement: AssistantThreadPlacement) => Promise<void>;
  setThreadPlacements: (placements: readonly AssistantThreadPlacement[]) => Promise<void>;
}
