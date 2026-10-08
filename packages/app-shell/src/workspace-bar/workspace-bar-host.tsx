import {
  WorkspaceBar,
  type WorkspaceBarBranchMenu,
  type WorkspaceBarMode,
  type WorkspaceBarProps,
  type WorkspaceBarWorktreeOption,
} from '@brainstrike/assistant-ui';
import { memo, type ReactElement } from 'react';
import { type UseWorkspaceBarArgs, useWorkspaceBar } from '../hooks/use-workspace-bar';

export interface WorkspaceBarHostProps extends UseWorkspaceBarArgs {
  /**
   * Present when the selected thread's folder-scope writes (its attached
   * folder set, operating root and Local/Worktree checkout binding) cannot be
   * committed: no durable owner, or an owner that refuses scope changes its
   * platform cannot validate yet. Every action whose last step writes one
   * of those facts is gated BEFORE its side effects run: Add folder and Recent
   * would mount the folder globally, and a new worktree would be created on
   * disk, before the thread write is refused. Add folder, Recent, New
   * worktree and "Use" render disabled with this reason; the drop zone and
   * "Switch in a new worktree", which have no disabled form, are omitted.
   */
  readonly threadFoldersUnavailableReason?: string | undefined;
}

/**
 * Removes every action that ends in a thread-scoped folder or checkout write.
 * Read-only orientation (folder, branch, PR chips), branch switching on the
 * folder itself, the worktree listing and its folder-access grant, copy,
 * reveal and terminal stay: their owners are the folder and its repository,
 * not the thread.
 */
function withoutThreadFolderWrites(bar: WorkspaceBarProps, reason: string): WorkspaceBarProps {
  const { branchMenu, mode, onDropItems: _dropRequiresThreadAttach, ...rest } = bar;
  return {
    ...rest,
    addFolderDisabledReason: reason,
    ...(branchMenu ? { branchMenu: withoutWorktreeSwitch(branchMenu) } : {}),
    ...(mode ? { mode: withoutCheckoutBinding(mode, reason) } : {}),
  };
}

function withoutWorktreeSwitch(menu: WorkspaceBarBranchMenu): WorkspaceBarBranchMenu {
  const { onSwitchInNewWorktree: _createsAWorktree, ...actions } = menu;
  return actions;
}

/**
 * "New worktree…" creates a worktree on disk and then binds the thread to it;
 * "Use" binds the thread to an existing one. Both render disabled with the
 * reason. An entry that is already unusable keeps its own reason and remedy.
 */
function withoutCheckoutBinding(mode: WorkspaceBarMode, reason: string): WorkspaceBarMode {
  return {
    ...mode,
    createDisabledReason: reason,
    picker: {
      ...mode.picker,
      options: mode.picker.options.map(
        (option): WorkspaceBarWorktreeOption =>
          option.usable ? { ...option, disabledReason: reason, usable: false } : option
      ),
    },
  };
}

/**
 * The app-shell side of the composer workspace bar: it owns `useWorkspaceBar`
 * and renders the store-free `<WorkspaceBar />` from @brainstrike/assistant-ui.
 *
 * It exists to BOUND a re-render. `useWorkspaceBar` holds five live-refresh
 * selector subscriptions across two distinct signals, so every git push and
 * every working-tree batch re-renders whichever component calls it:
 * `anyInvalidationNonce` (subscribed at four sites — `use-workspace-bar.ts:406`
 * for the MAIN-root re-resolve, `use-thread-checkout-status.ts:76` for the
 * dot, and TWICE more transitively through `useBranchSwitcher`, which reads
 * it directly and again via the `useGitInventory` call it makes) plus the
 * primary root's git-scope nonce (`use-thread-checkout-status.ts:79`, the
 * dot's own separate read). The switcher's post-mutation `reloadNonce` is
 * LOCAL state, not a subscription — it only ever advances from this hook's
 * own mutations, never from a push. Called in
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
export const WorkspaceBarHost = memo(function WorkspaceBarHost({
  threadFoldersUnavailableReason,
  ...args
}: WorkspaceBarHostProps): ReactElement {
  const composed = useWorkspaceBar(args);
  const barProps =
    threadFoldersUnavailableReason === undefined
      ? composed
      : withoutThreadFolderWrites(composed, threadFoldersUnavailableReason);
  return <WorkspaceBar {...barProps} />;
});
