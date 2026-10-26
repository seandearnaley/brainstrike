import { refusalError } from '@brainstrike/assistant-contract';
import type { MessageConnection } from 'vscode-jsonrpc';
import type {
  HostClientOrigin,
  HostGitWorkspace,
  HostGitWorkspaceMethod,
  HostGitWorkspaceMethods,
} from './ports.ts';
import { GIT_WORKSPACE_EVENT, type HostMethod, type HostParams } from './protocol.ts';

type SignalledHandler = <M extends HostMethod>(
  method: M,
  request: (params: HostParams<M>, signal: AbortSignal) => unknown
) => void;

/**
 * ADR-0029 stage 2: the desktop's git cluster on one authenticated connection.
 * Only the desktop's private clients reach it; the public socket never does.
 */
export function bindHostGitWorkspaceMethods(
  handle: SignalledHandler,
  connection: MessageConnection,
  workspace: HostGitWorkspace | undefined,
  origin: HostClientOrigin
): { dispose(): void } {
  let unsubscribe: (() => void) | undefined;
  const service = (): HostGitWorkspace => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.git-desktop-only',
        "Workspace git is available only to the desktop's private client"
      );
    }
    if (!workspace) {
      throw refusalError(
        'configuration',
        'workspace.git-unavailable',
        'Workspace git is unavailable on this host'
      );
    }
    return workspace;
  };
  const serve = <M extends HostGitWorkspaceMethod>(method: M): void => {
    handle(method, (params, signal) => {
      const methods: HostGitWorkspaceMethods = service();
      return methods[method](params, signal);
    });
  };
  handle('workspace/git/subscribe', () => {
    const owner = service();
    unsubscribe ??= owner.subscribe((event) => {
      connection.sendNotification(GIT_WORKSPACE_EVENT, event).catch(() => connection.dispose());
    });
    return { subscribed: true };
  });
  serve('changes/file-diff');
  serve('changes/inventory');
  serve('changes/resolve-view');
  serve('git/commit');
  serve('git/create-branch');
  serve('git/fetch');
  serve('git/push');
  serve('git/repository');
  serve('git/status');
  serve('git/switch-branch');
  serve('worktrees/adopt');
  serve('worktrees/archive');
  serve('worktrees/checkout-status');
  serve('worktrees/classify-path');
  serve('worktrees/create');
  serve('worktrees/create-branch-here');
  serve('worktrees/create-context');
  serve('worktrees/inspect-archive');
  serve('worktrees/list');
  serve('worktrees/managed-paths');
  serve('worktrees/restore');
  serve('worktrees/settings/read');
  serve('worktrees/settings/write');
  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
