import { WorkspaceBar } from '@brainstrike/assistant-ui';
import type { ReactElement } from 'react';
import { type UseWorkspaceBarArgs, useWorkspaceBar } from '../hooks/use-workspace-bar';

export type WorkspaceBarHostProps = UseWorkspaceBarArgs;

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
 * own mutations, never from a push. When the assistant panel wrapper (a large
 * component mounting the whole assistant) called the hook itself, a
 * `git commit` in another window re-rendered the entire wrapper. Here the same
 * signal re-renders ~30 lines of chips.
 *
 * The other half of the bound is the React Compiler: the parent
 * (`CommittedWorkspaceControls` in desktop) compiles, so a parent render that
 * changed none of the bar's inputs (store values, the repository, ids) reuses
 * the cached `<WorkspaceBarHost />` element and never reaches it. Rendering
 * this host from an uncompiled parent loses that half.
 */
export function WorkspaceBarHost(args: WorkspaceBarHostProps): ReactElement {
  const barProps = useWorkspaceBar(args);
  return <WorkspaceBar {...barProps} />;
}
