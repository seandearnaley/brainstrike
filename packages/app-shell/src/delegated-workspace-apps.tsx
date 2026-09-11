import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import {
  type DelegatedConversationRuntimeOptions,
  SubagentConversationNavigationContext,
} from '@brainstrike/assistant-ui';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { type DbHandle, useDbProviderError, usePGliteDatabase } from '@brainstrike/db/react';
import { type WorkspaceApp, WorkspaceTabsProvider } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { MessageSquare } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { DelegatedConversationPanel } from './delegated-conversation-panel';
import {
  DelegatedConversationRootsProvider,
  useDelegatedConversationRoot,
} from './delegated-conversation-root';
import { type ChildNode, loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import {
  type DelegatedWorkspaceTab,
  delegatedWorkspaceTabId,
  readDelegatedWorkspaceTab,
} from './delegated-workspace-tab';

/** Both main and child cards use the existing workspace's singleton tab action. */
export function DelegatedWorkspaceNavigation({
  children,
  ownerResourceId,
  rootThreadId,
}: {
  readonly children: ReactNode;
  readonly ownerResourceId: string;
  readonly rootThreadId: string | undefined;
}) {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  const open = useCallback(
    (threadId: string) => {
      if (!rootThreadId) {
        throw new Error('The owning conversation is unavailable.');
      }
      useWorkspaceTabSelectionStore
        .getState()
        .openApp(delegatedWorkspaceTabId({ ownerResourceId, rootThreadId, threadId }));
    },
    [ownerResourceId, rootThreadId]
  );
  return (
    <SubagentConversationNavigationContext value={root ? open : null}>
      {children}
    </SubagentConversationNavigationContext>
  );
}

function Failure({ error }: { readonly error: Error }) {
  return (
    <div className="p-4 text-destructive" role="alert">
      {error.message}
    </div>
  );
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type History = DelegatedConversationRuntimeOptions['history'];
function ChildView({ db, node }: { readonly db: DbHandle; readonly node: ChildNode }) {
  const root = useDelegatedConversationRoot(node.ownerResourceId, node.rootThreadId);
  if (!root) {
    throw new Error('The child workspace has no owning root registry.');
  }
  const live = useSyncExternalStore(
    root.store.subscribe,
    () => root.store.getConversation(node.threadId),
    () => root.store.getConversation(node.threadId)
  );
  const [saved, setSaved] = useState<{ readonly history: History } | { readonly error: Error }>();
  useEffect(() => {
    if (root?.store.getConversation(node.threadId)) {
      return;
    }
    let active = true;
    const adapter = createAssistantThreadHistoryAdapter({
      repository: createPgliteAssistantThreadRepository(db),
      resourceId: node.resourceId,
      threadId: node.threadId,
    });
    adapter.load().then(
      (history) => {
        if (active) {
          setSaved({ history });
        }
      },
      (error: unknown) => {
        if (active) {
          setSaved({ error: asError(error) });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [db, node.resourceId, node.threadId, root]);
  if (saved && 'error' in saved) {
    return <Failure error={saved.error} />;
  }
  if (!(saved || live)) {
    return (
      <p className="p-4" role="status">
        Loading conversation…
      </p>
    );
  }
  return (
    <DelegatedWorkspaceNavigation
      ownerResourceId={node.ownerResourceId}
      rootThreadId={node.rootThreadId}
    >
      <DelegatedConversationPanel
        label={node.displayName}
        onNew={(message) => root.sendDecision(node.threadId, message)}
        {...(saved ? { persistedHistory: saved.history } : {})}
        store={root.store}
        threadId={node.threadId}
      />
    </DelegatedWorkspaceNavigation>
  );
}

type Entry =
  | { readonly db: DbHandle; readonly node: ChildNode }
  | { readonly db: DbHandle; readonly error: Error };
const colors: Record<ChildNode['color'], string> = {
  amber: 'text-amber-500',
  blue: 'text-blue-500',
  emerald: 'text-emerald-500',
  rose: 'text-rose-500',
  slate: 'text-slate-500',
  violet: 'text-violet-500',
};

type AddressEntry =
  | { readonly id: string; readonly address: DelegatedWorkspaceTab }
  | { readonly id: string; readonly error: Error };

export function useDelegatedWorkspaceApps(): readonly WorkspaceApp[] {
  const openIds = useWorkspaceTabSelectionStore((state) => state.openAppIds);
  const db = usePGliteDatabase();
  const dbError = useDbProviderError();
  const addresses = useMemo(
    () =>
      openIds.flatMap<AddressEntry>((id) => {
        try {
          const address = readDelegatedWorkspaceTab(id);
          return address ? [{ address, id }] : [];
        } catch (error) {
          return [{ error: asError(error), id }];
        }
      }),
    [openIds]
  );
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(() => new Map());
  useEffect(() => {
    if (!db) {
      return;
    }
    let active = true;
    const repository = createDelegatedConversationRepository(db);
    // Retain metadata only while its tab remains open. A reopen must authorize
    // again before any prior node can be used to read a native transcript.
    const open = new Set(addresses.map((item) => item.id));
    setEntries(
      (previous) => new Map([...previous].filter(([id, entry]) => open.has(id) && entry.db === db))
    );
    for (const item of addresses) {
      if (!('address' in item)) {
        continue;
      }
      loadDelegatedWorkspaceNode(repository, item.address).then(
        (node) => {
          if (active) {
            setEntries((previous) => new Map(previous).set(item.id, { db, node }));
          }
        },
        (error: unknown) => {
          if (active) {
            setEntries((previous) => new Map(previous).set(item.id, { db, error: asError(error) }));
          }
        }
      );
    }
    return () => {
      active = false;
    };
  }, [addresses, db]);
  return addresses.map((item): WorkspaceApp => {
    const cached = entries.get(item.id);
    const entry = cached?.db === db ? cached : undefined;
    const error =
      'error' in item
        ? item.error
        : (dbError ?? (entry && 'error' in entry ? entry.error : undefined));
    const node = entry && 'node' in entry ? entry.node : undefined;
    return {
      icon: ({ className }) => (
        <MessageSquare className={`${className ?? ''} ${node ? colors[node.color] : ''}`} />
      ),
      id: item.id,
      label: node?.displayName ?? 'Child conversation',
      render: () => {
        if (error) {
          return <Failure error={asError(error)} />;
        }
        if (!(db && node)) {
          return (
            <p className="p-4" role="status">
              Loading conversation…
            </p>
          );
        }
        return <ChildView db={db} key={item.id} node={node} />;
      },
    };
  });
}

export function DelegatedWorkspaceTabsProvider({
  apps,
  children,
}: {
  readonly apps: readonly WorkspaceApp[];
  readonly children: ReactNode;
}) {
  const childApps = useDelegatedWorkspaceApps();
  return (
    <DelegatedConversationRootsProvider>
      <WorkspaceTabsProvider apps={[...apps, ...childApps]}>{children}</WorkspaceTabsProvider>
    </DelegatedConversationRootsProvider>
  );
}
