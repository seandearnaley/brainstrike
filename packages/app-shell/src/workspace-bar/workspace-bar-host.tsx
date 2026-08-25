import { WorkspaceBar } from '@brainstrike/assistant-ui';
import { memo, type ReactElement } from 'react';
import { type UseWorkspaceBarArgs, useWorkspaceBar } from '../hooks/use-workspace-bar';

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
export const WorkspaceBarHost = memo(function WorkspaceBarHost(
  args: UseWorkspaceBarArgs
): ReactElement {
  const barProps = useWorkspaceBar(args);
  return <WorkspaceBar {...barProps} />;
});
