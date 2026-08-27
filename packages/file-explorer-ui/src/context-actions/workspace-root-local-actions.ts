import {
  type ActionOutcome,
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { Star, Unplug } from 'lucide-react';

export interface WorkspaceRootLocalActionDeps {
  /**
   * STAGED, like the vault's Delete…: this opens the existing
   * `DisconnectRootDialog`; the dialog's confirm performs the removal
   * (ui-conventions: a destructive action never mutates from a menu run).
   *
   * Optional and gates the action's presence, mirroring the header's own X
   * button (`onDisconnect ? handleDisconnectRequest : undefined`). Omit —
   * never disable — when the caller has no way to remove the root: an
   * unconditionally-visible Disconnect… that resolves `{ ok: true }` while
   * doing nothing is exactly the silent-fallback shape AGENTS.md forbids.
   */
  readonly onDisconnect?: ((target: TargetOf<'workspace-root'>) => void) | undefined;
  /**
   * The WORKSPACE-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) — the
   * role this same header renders as its "Main" badge. NOT the workspace
   * bar's per-thread primary (BST-1393 ruling R1).
   *
   * Returns an `ActionOutcome` rather than `void`: `setMainRoot` warn-and-
   * no-ops for an id `activeRootIds` doesn't recognize (a legacy
   * path-identity root — see `RootSection`'s `rootIdentity` fallback), and a
   * `run` that always resolves `{ ok: true }` regardless would swallow that
   * failure with no toast, no log, and no visible effect for the user.
   */
  readonly onSetAsMain: (target: TargetOf<'workspace-root'>) => ActionOutcome;
}

/**
 * Surface-local `workspace-root` actions: they close over the file-explorer
 * store and the section's own dialog state, so they travel through
 * `ActionContextMenu`'s `localActions` prop rather than the global registry
 * (`ui-conventions.md` CONTEXT ACTION SYSTEM).
 *
 * `ActionContextMenu` toasts and logs failures centrally, so `run` only ever
 * returns an `ActionOutcome`.
 */
export function buildWorkspaceRootLocalActions({
  onDisconnect,
  onSetAsMain,
}: WorkspaceRootLocalActionDeps): AnyContextAction[] {
  const actions: AnyContextAction[] = [
    defineContextAction<'workspace-root'>({
      appliesTo: ['workspace-root'],
      group: 'primary',
      icon: Star,
      id: 'workspace-root.set-as-main',
      // Hidden, not disabled: "make this the Main root" has no meaning for
      // the root that already is one.
      isVisible: (target) => !target.isMain,
      label: 'Set as Main',
      run: (target) => Promise.resolve(onSetAsMain(target)),
    }),
  ];
  if (onDisconnect) {
    actions.push(
      defineContextAction<'workspace-root'>({
        appliesTo: ['workspace-root'],
        group: 'danger',
        icon: Unplug,
        id: 'workspace-root.disconnect',
        label: 'Disconnect…',
        run: (target) => {
          onDisconnect(target);
          return Promise.resolve({ ok: true });
        },
      })
    );
  }
  return actions;
}
