import {
  type AnyContextAction,
  type ContextAction,
  defineContextAction,
} from '@brainstrike/context-actions';
import { Copy, FolderOpen } from 'lucide-react';
import { revealLabel } from './file-entry-actions';

/**
 * The two `workspace-root` actions that close over NOTHING but
 * `ActionServices`, which is what makes them global-registry members rather
 * than surface-local ones (`ui-conventions.md`: surface-local actions are the
 * ones that close over surface stores). Set as main, Disconnect, Open in
 * Terminal and New thread here all close over a store or a bridge and travel
 * through `localActions` instead — see `workspace-root-local-actions.ts` and
 * `packages/app-shell/src/workspace-root-context-actions.tsx`.
 *
 * Both HIDE for a pathless root (`isVisible`), never disable: a web FSA root
 * genuinely has no path, and ui-conventions rules data-shaped gating hidden.
 */
const NO_PATH = 'This folder has no filesystem path.';

const copyWorkspaceRootPath: ContextAction<'workspace-root'> = {
  appliesTo: ['workspace-root'],
  group: 'copy',
  icon: Copy,
  id: 'workspace-root.copy-path',
  isVisible: (target) => target.path !== null,
  label: 'Copy Path',
  requiredCapabilities: ['clipboard'],
  run: async (target, services) => {
    if (target.path === null) {
      return { error: NO_PATH, ok: false };
    }
    if (!services.clipboard) {
      return { error: 'Clipboard service unavailable', ok: false };
    }
    const outcome = await services.clipboard.writeText(target.path);
    return outcome.ok ? { message: 'Folder path copied', ok: true } : outcome;
  },
};

const revealWorkspaceRoot: ContextAction<'workspace-root'> = {
  appliesTo: ['workspace-root'],
  group: 'navigate',
  icon: FolderOpen,
  id: 'workspace-root.reveal',
  isVisible: (target) => target.path !== null,
  // Never a hardcoded OS name — same helper the workspace bar's reveal uses.
  label: () => revealLabel(),
  requiredCapabilities: ['fs.reveal'],
  run: async (target, services) => {
    if (target.path === null) {
      return { error: NO_PATH, ok: false };
    }
    if (!services.platformFs) {
      return { error: 'Platform file-system service unavailable', ok: false };
    }
    return await services.platformFs.showItemInFolder(target.path);
  },
};

export const copyWorkspaceRootPathAction = defineContextAction(copyWorkspaceRootPath);
export const revealWorkspaceRootAction = defineContextAction(revealWorkspaceRoot);

export const workspaceRootActions: readonly AnyContextAction[] = [
  copyWorkspaceRootPathAction,
  revealWorkspaceRootAction,
];
