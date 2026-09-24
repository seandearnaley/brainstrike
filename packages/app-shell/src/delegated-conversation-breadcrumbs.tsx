import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { SubagentConversationNavigationContext } from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { Breadcrumbs } from '@brainstrike/ui';
import { use, useEffect, useState } from 'react';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
} from './assistant-thread-presentation';
import { loadDelegatedConversationAncestry } from './delegated-conversation-ancestry';
import type { ChildNode } from './delegated-workspace-node';

type Ancestry = { readonly node: ChildNode; readonly db: DbHandle } & (
  | { readonly trail: Awaited<ReturnType<typeof loadDelegatedConversationAncestry>> }
  | { readonly error: Error }
);
const Icon = ASSISTANT_THREAD_ICON_PRESENTATION.message.iconComponent;

export function DelegatedConversationBreadcrumbs({
  db,
  node,
}: {
  readonly db: DbHandle;
  readonly node: ChildNode;
}) {
  const navigate = use(SubagentConversationNavigationContext);
  const workspace = useFileExplorerStoreSelector((state) =>
    node.workspaceRootId ? state.rootDescriptors?.[node.workspaceRootId] : undefined
  );
  const rootTitle = useAssistantThreadStore(
    (state) =>
      state.threadsByResourceId[node.ownerResourceId]?.find(
        (thread) => thread.id === node.rootThreadId
      )?.title
  );
  const [ancestry, setAncestry] = useState<Ancestry>();
  useEffect(() => {
    let active = true;
    loadDelegatedConversationAncestry(createDelegatedConversationRepository(db), node).then(
      (trail) => {
        if (active) {
          setAncestry({ db, node, trail });
        }
      },
      (error: unknown) => {
        if (active) {
          setAncestry({
            db,
            error: error instanceof Error ? error : new Error(String(error)),
            node,
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [db, node]);
  const current = ancestry?.db === db && ancestry.node === node ? ancestry : undefined;
  const appearance = ASSISTANT_THREAD_COLOR_PRESENTATION[node.color];
  return (
    <header
      className={`shrink-0 space-y-2 border-b px-4 py-3 ${appearance.idleClassName}`}
      data-agent-color={node.color}
    >
      {current ? (
        'error' in current ? (
          <p className="text-destructive text-xs" role="alert">
            {current.error.message}
          </p>
        ) : (
          <Breadcrumbs
            ariaLabel="Conversation ancestry"
            className="[&_ol]:flex-wrap"
            onSegmentClick={navigate ? (path) => navigate(path) : undefined}
            segments={[
              { label: rootTitle ?? 'Main conversation', path: current.trail.root.threadId },
              ...current.trail.children.map((ancestor) => ({
                label: ancestor.displayName,
                path: ancestor.threadId,
              })),
            ]}
          />
        )
      ) : (
        <p className="text-muted-foreground text-xs" role="status">
          Loading ancestry…
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className={`rounded-md border p-1 ${appearance.markClassName}`}>
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <h2 className="truncate font-semibold text-sm">{node.displayName}</h2>
      </div>
      <p className="text-muted-foreground text-xs" data-testid="child-workspace-mode">
        {node.workspaceRootId
          ? `Shared workspace: ${workspace?.displayName ?? 'bound folder is no longer open'}`
          : 'Shared workspace: tools select an open folder'}
        <span className="block">
          File edits are serialized per path. Changes stay in this workspace.
        </span>
      </p>
    </header>
  );
}
