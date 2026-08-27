import {
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
   */
  readonly onDisconnect: (target: TargetOf<'workspace-root'>) => void;
  /**
   * The WORKSPACE-wide MAIN root (`setMainRoot`, `activeRootIds[0]`) — the
   * role this same header renders as its "Main" badge. NOT the workspace
   * bar's per-thread primary (BST-1393 ruling R1).
   */
  readonly onSetAsMain: (target: TargetOf<'workspace-root'>) => void;
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
  return [
    defineContextAction<'workspace-root'>({
      appliesTo: ['workspace-root'],
      group: 'primary',
      icon: Star,
      id: 'workspace-root.set-as-main',
      // Hidden, not disabled: "make this the Main root" has no meaning for
      // the root that already is one.
      isVisible: (target) => !target.isMain,
      label: 'Set as Main',
      run: (target) => {
        onSetAsMain(target);
        return Promise.resolve({ ok: true });
      },
    }),
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
    }),
  ];
}
