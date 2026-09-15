import { Button } from '@brainstrike/ui';
import { useSyncExternalStore } from 'react';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
} from './assistant-thread-presentation';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';
import { threadWorkspaceNavigation } from './thread-workspace/live-thread-workspace-navigation';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';

const Icon = ASSISTANT_THREAD_ICON_PRESENTATION.message.iconComponent;
const emptySubscribe = () => () => undefined;
function ChildRow({ row }: { readonly row: Extract<DelegatedSidebarRow, { kind: 'delegated' }> }) {
  const root = useDelegatedConversationRoot(row.node.ownerResourceId, row.node.rootThreadId);
  const snapshot = useSyncExternalStore(root?.store.subscribe ?? emptySubscribe, () =>
    root?.store.getConversation(row.node.threadId)
  );
  const unread = useSyncExternalStore(
    root?.store.subscribe ?? emptySubscribe,
    () => root?.store.hasUnread(row.node.threadId) ?? false
  );
  const status = snapshot?.update.message.status.type;
  const needsInput = snapshot ? status === 'requires-action' : row.needsInput;
  return (
    <button
      className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
      onClick={() =>
        threadWorkspaceNavigation.open(row.node.ownerResourceId, row.node.rootThreadId, row.id)
      }
      type="button"
    >
      <Icon
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${ASSISTANT_THREAD_COLOR_PRESENTATION[row.node.color].markClassName}`}
      />
      <span className="truncate">{row.node.displayName}</span>
      {unread ? (
        <span aria-label="Unread child activity" className="shrink-0 text-xs" role="img">
          •
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-muted-foreground">
        {status === 'running' ? 'Working' : needsInput ? 'Needs input' : 'Child'}
      </span>
    </button>
  );
}
export function DelegatedSidebarCell({
  row,
  onShowMore,
}: {
  readonly row: DelegatedSidebarRow;
  readonly onShowMore: (id: string) => void;
}) {
  if (row.kind === 'delegated') {
    return <ChildRow row={row} />;
  }
  const moreFor = row.moreFor;
  if (moreFor) {
    return (
      <Button onClick={() => onShowMore(moreFor)} size="sm" variant="ghost">
        {row.label}
      </Button>
    );
  }
  return (
    <p
      className={`px-2 py-1 text-xs ${row.isError ? 'text-destructive' : 'text-muted-foreground'}`}
      role={row.isError ? 'alert' : 'status'}
    >
      {row.label}
    </p>
  );
}
