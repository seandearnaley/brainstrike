import type { AgentSemanticColor } from './agent-color.js';
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
  | { readonly operation: 'clear'; readonly threadIds: readonly string[] };
export interface ThreadGroupsReply {
  readonly groups: readonly AssistantThreadGroup[];
  readonly placements: readonly AssistantThreadPlacement[];
}
export interface ThreadGroupsPort {
  threadGroups(request: ThreadGroupsRequest): Promise<ThreadGroupsReply>;
}

export interface ThreadCatalogRoot {
  readonly displayName: string;
  readonly id: string;
  readonly path: string;
  readonly status: 'live' | 'disconnected';
}
export interface ThreadGroupsCapability {
  readRoots(): Promise<readonly ThreadCatalogRoot[]>;
  request(input: ThreadGroupsRequest): Promise<ThreadGroupsReply>;
}
