/**
 * The two `workspace-root` context actions that need app-shell's own seams,
 * injected into `FileExplorerPanel`'s `rootActions` prop (BST-1393). They
 * cannot live in `file-explorer-ui` beside the other four: that package does
 * not — and must not — depend on `@brainstrike/app-shell`.
 *
 * Both are capability-gated by ABSENCE. `isTerminalBridgeAvailable()` is
 * resolved once per hook instance (the `use-workspace-bar-terminal.ts`
 * idiom), and `useCreateThreadInFolder()` returns `null` until the thread
 * repository resolves — so web renders neither item and a booting desktop
 * renders no dead "New thread here".
 */
import { type AnyContextAction, defineContextAction } from '@brainstrike/context-actions';
import { MessageSquarePlus, SquareTerminal } from 'lucide-react';
import { useMemo } from 'react';
import { useCreateThreadInFolder } from './hooks/use-create-thread-in-folder';
import { useTerminalTargetStore } from './stores/terminal-target-store';
import { isTerminalBridgeAvailable } from './terminal-panel/terminal-bridge';

export function useWorkspaceRootActions(): readonly AnyContextAction[] {
  const terminalAvailable = useMemo(() => isTerminalBridgeAvailable(), []);
  const createThreadInFolder = useCreateThreadInFolder();
  return useMemo(() => {
    const actions: AnyContextAction[] = [];
    if (terminalAvailable) {
      actions.push(
        defineContextAction<'workspace-root'>({
          appliesTo: ['workspace-root'],
          group: 'navigate',
          icon: SquareTerminal,
          id: 'workspace-root.open-in-terminal',
          isVisible: (target) => target.path !== null,
          label: 'Open in Terminal',
          run: (target) => {
            if (target.path === null) {
              return Promise.resolve({ error: 'This folder has no filesystem path.', ok: false });
            }
            // A mounted ROOT is its own cwd, so `rootId` and `path` name the
            // same folder here — the simplest case of the BST-1457 seam. Both
            // still travel: main authorizes on the first and, after a
            // containment check, spawns in the second.
            useTerminalTargetStore
              .getState()
              .openTerminalAt({ cwd: target.path, rootId: target.rootId });
            return Promise.resolve({ ok: true });
          },
        })
      );
    }
    if (createThreadInFolder) {
      actions.push(
        defineContextAction<'workspace-root'>({
          appliesTo: ['workspace-root'],
          group: 'primary',
          icon: MessageSquarePlus,
          id: 'workspace-root.new-thread-here',
          label: 'New Thread Here',
          run: (target) => {
            // `ThreadFolderBinding.path` is REQUIRED `string | null` — pass
            // `target.path` directly (already `string | null` on a
            // `workspace-root` target), never a conditional spread that
            // would drop the key when null.
            createThreadInFolder({
              displayName: target.displayName,
              path: target.path,
              rootId: target.rootId,
            });
            return Promise.resolve({ ok: true });
          },
        })
      );
    }
    return actions;
  }, [createThreadInFolder, terminalAvailable]);
}
