import type { HostBrowserOriginAnswers } from '@brainstrike/agent-host/protocol';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/** BST-1178: the sites the agent host saved an answer for, read and removed by Settings. */
export interface DesktopHostBrowserOrigins {
  read(): Promise<HostBrowserOriginAnswers>;
  remove(origin: string): Promise<void>;
}

/** Over one host connection: the host owns the answers; this window only asks. */
function createDesktopHostBrowserOrigins(
  connection: DesktopHostConnection
): DesktopHostBrowserOrigins {
  return {
    read: async () =>
      (await (await connection.current()).request('permissions/origins/read', {})).origins,
    remove: async (origin) => {
      await (await connection.current()).request('permissions/origins/remove', { origin });
    },
  };
}

let windowOrigins: DesktopHostBrowserOrigins | undefined;

/** `null` where this window has no agent-host capability (web). */
export function resolveDesktopHostBrowserOrigins(): DesktopHostBrowserOrigins | null {
  if (!window.agentHost) {
    return null;
  }
  windowOrigins ??= createDesktopHostBrowserOrigins(windowHostConnection());
  return windowOrigins;
}
