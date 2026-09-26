import { createDelegatedConversationRepository } from '@brainstrike/db';
import { type DbHandle, useDbProviderError, usePGliteDatabase } from '@brainstrike/db/react';
import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { MessageSquare } from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { getDelegatedColorPresentation } from './agent-color-presentation';
import {
  getDelegatedColorRevision,
  subscribeDelegatedColorRefresh,
} from './delegated-color-refresh';
import { ChildAppSurface } from './delegated-workspace-child-app-surface';
import { Failure } from './delegated-workspace-child-view';
import { type ChildNode, loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import { type DelegatedWorkspaceTab, readDelegatedWorkspaceTab } from './delegated-workspace-tab';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type Entry =
  | { readonly db: DbHandle; readonly revision: number; readonly node: ChildNode }
  | { readonly db: DbHandle; readonly revision: number; readonly error: Error };
type AddressEntry =
  | { readonly id: string; readonly address: DelegatedWorkspaceTab }
  | { readonly id: string; readonly error: Error };

function renderChildApp(
  db: DbHandle | null,
  error: Error | undefined,
  id: string,
  node: ChildNode | undefined
): ReactNode {
  if (error) {
    return <Failure error={error} />;
  }
  if (!(db && node)) {
    return (
      <p className="p-4" role="status">
        Loading conversation…
      </p>
    );
  }
  return <ChildAppSurface db={db} id={id} key={id} node={node} />;
}

function resolveAppEntry(
  item: AddressEntry,
  db: DbHandle | null,
  dbError: Error | null,
  entries: ReadonlyMap<string, Entry>
): { readonly error: Error | undefined; readonly node: ChildNode | undefined } {
  const cached = entries.get(item.id);
  // Keep the mounted child view while its color-only reread is pending. A
  // database switch still clears the old view, and the new read replaces it.
  const entry = cached?.db === db ? cached : undefined;
  const error =
    'error' in item
      ? item.error
      : (dbError ?? (entry && 'error' in entry ? entry.error : undefined));
  const node = entry && 'node' in entry ? entry.node : undefined;
  return { error, node };
}

export function useDelegatedWorkspaceApps(): readonly WorkspaceApp[] {
  const colorRevision = useSyncExternalStore(
    subscribeDelegatedColorRefresh,
    getDelegatedColorRevision
  );
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
  const readEntry = useEffectEvent((id: string) => entries.get(id));
  useEffect(
    () =>
      useWorkspaceTabSelectionStore.subscribe((state, previous) => {
        if (state.openAppIds === previous.openAppIds) {
          return;
        }
        const open = new Set(state.openAppIds);
        setEntries(
          (entries) =>
            new Map([...entries].filter(([id, entry]) => open.has(id) && entry.db === db))
        );
      }),
    [db]
  );

  useEffect(() => {
    if (!db) {
      return;
    }
    let active = true;
    const repository = createDelegatedConversationRepository(db);
    for (const item of addresses) {
      const cached = readEntry(item.id);
      if (!('address' in item) || (cached?.db === db && cached.revision === colorRevision)) {
        continue;
      }
      loadDelegatedWorkspaceNode(repository, item.address).then(
        (node) => {
          if (active) {
            setEntries((previous) =>
              new Map(previous).set(item.id, { db, node, revision: colorRevision })
            );
          }
        },
        (error: unknown) => {
          if (active) {
            setEntries((previous) =>
              new Map(previous).set(item.id, { db, error: asError(error), revision: colorRevision })
            );
          }
        }
      );
    }
    return () => {
      active = false;
    };
  }, [addresses, colorRevision, db]);
  return useMemo(
    () =>
      addresses.map((item): WorkspaceApp => {
        const { error, node } = resolveAppEntry(item, db, dbError, entries);
        const appearance = node ? getDelegatedColorPresentation(node.color) : undefined;
        return {
          icon: ({ className }) => <MessageSquare className={className} />,
          id: item.id,
          label: node?.displayName ?? 'Child conversation',
          ...(appearance && node
            ? {
                tabAppearance: {
                  accentClassName: appearance.accentClassName,
                  colorId: node.color,
                  idleClassName: appearance.idleClassName,
                  markClassName: appearance.markClassName,
                  selectedClassName: appearance.selectedClassName,
                  style: appearance.style,
                },
              }
            : {}),
          render: () => renderChildApp(db, error, item.id, node),
        };
      }),
    [addresses, db, dbError, entries]
  );
}
