import type { AgentSemanticColor } from './agent-color.ts';
export const ASSISTANT_THREAD_ICON_IDS = [
  'message',
  'bug',
  'code',
  'rocket',
  'research',
  'plan',
] as const;
export type AssistantThreadIconId = (typeof ASSISTANT_THREAD_ICON_IDS)[number];
export interface AssistantThreadGroup {
  readonly color: AgentSemanticColor | null;
  readonly icon: AssistantThreadIconId | null;
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
/** A thread pinned to the top of the Threads panel, newest pin first. */
export interface AssistantThreadPin {
  /** Epoch ms of the pin; the Pinned section lists newer pins first. */
  readonly pinnedAt: number;
  readonly resourceId: string;
  readonly threadId: string;
}
export interface AssistantThreadGroupRankEntry {
  readonly groupId: string;
  readonly rank: string;
}
export type ThreadGroupsRequest =
  | { readonly operation: 'list'; readonly resourceId: string }
  | { readonly operation: 'create'; readonly group: AssistantThreadGroup }
  | { readonly operation: 'delete'; readonly groupId: string }
  | { readonly operation: 'rename'; readonly groupId: string; readonly name: string }
  | {
      readonly operation: 'color';
      readonly groupId: string;
      readonly color: AgentSemanticColor | null;
    }
  | {
      readonly operation: 'icon';
      readonly groupId: string;
      readonly icon: AssistantThreadIconId | null;
    }
  | { readonly operation: 'ranks'; readonly entries: readonly AssistantThreadGroupRankEntry[] }
  | { readonly operation: 'placements'; readonly placements: readonly AssistantThreadPlacement[] }
  | { readonly operation: 'pin'; readonly pin: AssistantThreadPin }
  | { readonly operation: 'unpin'; readonly threadId: string }
  /** Forgets the threads' placements and pins: the threads were deleted. */
  | { readonly operation: 'clear'; readonly threadIds: readonly string[] };
export interface ThreadGroupsReply {
  readonly groups: readonly AssistantThreadGroup[];
  readonly pins: readonly AssistantThreadPin[];
  readonly placements: readonly AssistantThreadPlacement[];
}
export interface ThreadGroupsPort {
  threadGroups(request: ThreadGroupsRequest): Promise<ThreadGroupsReply>;
}

export interface ThreadCatalogRoot {
  readonly displayName: string;
  readonly id: string;
  readonly path: string;
  /**
   * The project the root's record names (ADR-0034, owner decisions 2026-11-10);
   * null for a managed worktree's root and a folder recorded before projects.
   */
  readonly projectId: string | null;
  readonly status: 'live' | 'disconnected';
}
export interface ThreadGroupsCapability {
  readRoots(): Promise<readonly ThreadCatalogRoot[]>;
  request(input: ThreadGroupsRequest): Promise<ThreadGroupsReply>;
}
