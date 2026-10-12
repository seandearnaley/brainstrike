import type { AgentColor } from '@brainstrike/types/agent-color';
import type { AssistantThreadHostChild } from './assistant-thread-host-context';

/** A child row, or a parent's loading, empty or error state, beneath an expanded host thread. */
export type DelegatedSidebarRow = {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  readonly groupId: string | null;
} & (
  | {
      readonly kind: 'delegated-state';
      readonly label: string;
      readonly isError: boolean;
    }
  | {
      /** BST-1932: an agent host child, read from the host, never from history. */
      readonly kind: 'host-child';
      readonly child: AssistantThreadHostChild;
      readonly parentColor?: AgentColor | undefined;
      /** The top-level thread the child belongs to: its tab opens in that root's workspace. */
      readonly root: { readonly resourceId: string; readonly threadId: string };
      readonly unread: boolean;
    }
);
