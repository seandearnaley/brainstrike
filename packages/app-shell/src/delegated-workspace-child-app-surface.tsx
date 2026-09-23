import type { DbHandle } from '@brainstrike/db/react';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { Activity } from 'react';
import { ChildView } from './delegated-workspace-child-view';
import type { ChildNode } from './delegated-workspace-node';

/** Keep each child view's draft and scroll state, but pause its subscriptions off screen. */
export function ChildAppSurface({
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
