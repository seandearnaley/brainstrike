import { WorkspaceBar } from '@brainstrike/assistant-ui';
import { memo, type ReactElement, useMemo, useState } from 'react';
import { resolveGitBridge } from '../git-panel/git-bridge';
import { type UseWorkspaceBarArgs, useWorkspaceBar } from '../hooks/use-workspace-bar';
import { useWorkspaceBranchMenu } from './use-workspace-branch-menu';

/**
 * The app-shell side of the composer workspace bar: it owns `useWorkspaceBar`
 * and renders the store-free `<WorkspaceBar />` from @brainstrike/assistant-ui.
 *
 * It exists to BOUND a re-render. `useWorkspaceBar` holds two live-refresh
 * subscriptions (`anyInvalidationNonce` for the MAIN-root re-resolve, and the
 * branch chip's own git-scope nonce), so every git push and every working-tree
 * batch re-renders whichever component calls it. Called in
 * `assistant-ui-panel-wrapper.tsx` — an ~1850-line component mounting the whole
 * assistant — that meant a `git commit` in another window re-rendered the
 * entire panel wrapper. Here the same signal re-renders ~30 lines of chips.
 *
 * `memo` is the other half of the bound: the wrapper re-renders constantly
 * (streaming, usage, model changes), and every one of those renders would
 * otherwise re-render the bar. The wrapper passes only stable references
 * (store values, the db handle, ids), so the shallow prop compare bails out —
 * a wrapper render that changed none of the bar's inputs never reaches it.
 */
export const WorkspaceBarHost = memo(function WorkspaceBarHost(
  args: UseWorkspaceBarArgs
): ReactElement {
  const baseBarProps = useWorkspaceBar(args);
  const bridge = useMemo(() => resolveGitBridge(), []);
  const root = baseBarProps.primaryRoot?.path
    ? { path: baseBarProps.primaryRoot.path, rootId: baseBarProps.primaryRoot.rootId }
    : null;
  const [branchOverride, setBranchOverride] = useState<{
    readonly branch: string;
    readonly rootId: string;
  } | null>(null);
  const branchMenu = useWorkspaceBranchMenu({
    bridge,
    checkout: baseBarProps.checkout,
    onBranchChanged: (branch) => {
      if (root) {
        setBranchOverride({ branch, rootId: root.rootId });
      }
    },
    root,
  });
  const activeBranchOverride =
    branchOverride && branchOverride.rootId === root?.rootId ? branchOverride.branch : null;
  const checkout =
    baseBarProps.checkout && activeBranchOverride
      ? { ...baseBarProps.checkout, branch: activeBranchOverride }
      : baseBarProps.checkout;
  const barProps = { ...baseBarProps, branchMenu: branchMenu ?? undefined, checkout };
  return <WorkspaceBar {...barProps} />;
});
