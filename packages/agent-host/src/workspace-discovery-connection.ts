import { refusalError } from '@brainstrike/assistant-contract';
import type { HostClientOrigin, HostWorkspaceDiscovery } from './ports.ts';
import type { HostMethod, HostParams } from './protocol.ts';

type SignalledHandler = <M extends HostMethod>(
  method: M,
  request: (params: HostParams<M>, signal: AbortSignal) => unknown
) => void;

/**
 * ADR-0029 stage 2: the skills, commands and trust each root contributes, for
 * Settings and the composer's "/" menu. Stage 2a: Settings' persona checks and
 * instructions files are the desktop user's, so only its private client reaches them.
 */
export function bindHostWorkspaceDiscoveryMethods(
  handle: SignalledHandler,
  workspaceDiscovery: HostWorkspaceDiscovery | undefined,
  origin: HostClientOrigin
): void {
  const discovery = (): HostWorkspaceDiscovery => {
    if (!workspaceDiscovery) {
      throw refusalError(
        'configuration',
        'workspace.discovery-unavailable',
        'Skills and user commands are unavailable on this host'
      );
    }
    return workspaceDiscovery;
  };
  const desktopDiscovery = (): HostWorkspaceDiscovery => {
    if (origin !== 'desktop-ui') {
      throw refusalError(
        'authorization',
        'workspace.discovery-desktop-only',
        "Personas and workspace instructions files are available only to the desktop's private client"
      );
    }
    return discovery();
  };
  handle('workspace/skills', (_params, signal) => discovery().skills(signal));
  handle('workspace/commands', (_params, signal) => discovery().commands(signal));
  handle('workspace/trust/list', (_params, signal) => discovery().trust(signal));
  handle('workspace/personas', (_params, signal) => desktopDiscovery().personas(signal));
  handle('workspace/context-files', (_params, signal) => desktopDiscovery().contextFiles(signal));
}
