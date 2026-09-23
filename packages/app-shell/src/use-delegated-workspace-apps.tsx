import { createDelegatedConversationRepository } from '@brainstrike/db';
import { type DbHandle, useDbProviderError, usePGliteDatabase } from '@brainstrike/db/react';
import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { MessageSquare } from 'lucide-react';
import { Activity, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { ChildView, Failure } from './delegated-workspace-child-view';
import { type ChildNode, loadDelegatedWorkspaceNode } from './delegated-workspace-node';
import { type DelegatedWorkspaceTab, readDelegatedWorkspaceTab } from './delegated-workspace-tab';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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

/** Keep each child view's draft and scroll state, but pause its subscriptions off screen. */
function ChildAppSurface({
  db,
  id,
  node,
}: {
  readonly db: DbHandle;
  readonly id: string;
  readonly node: ChildNode;
}) {
  const isSelected = useWorkspaceTabSelectionStore(
    (state) => state.selection.kind === 'app' && state.selection.appId === id
  );
  return (
    <Activity mode={isSelected ? 'visible' : 'hidden'}>
      <ChildView db={db} node={node} />
    </Activity>
  );
}

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
      if (!('address' in item) || readEntry(item.id)?.db === db) {
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
  return useMemo(
    () =>
      addresses.map((item): WorkspaceApp => {
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
            return <ChildAppSurface db={db} id={item.id} key={item.id} node={node} />;
          },
        };
      }),
    [addresses, db, dbError, entries]
  );
}
