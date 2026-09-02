import {
  installMcpAppElectronSandboxPolicy,
  type McpAppElectronSandboxLease,
} from '@brainstrike/mcp-app-host';
import type { App, Event as ElectronEvent, WebContents } from 'electron';

export const MCP_APP_SANDBOX_PARTITION = 'mcp-app:thread' as const;

type SandboxInstallOptions = Parameters<typeof installMcpAppElectronSandboxPolicy>[0];
type SandboxWebContents = WebContents & SandboxInstallOptions['webContents'];
type SandboxSession = ReturnType<SandboxInstallOptions['sessions']['fromPartition']>;
type SandboxSessions = SandboxInstallOptions['sessions'] & { readonly defaultSession: object };

interface McpAppsSandboxStartupOptions {
  readonly app: Pick<App, 'on' | 'removeListener'>;
  readonly onTeardownError: (error: unknown) => void;
  /**
   * Lazily yields Electron's `session` module surface. It is first read when a
   * WebContents appears, never at boot: `defaultSession` is only compared by
   * identity so the host window is rejected before any partition is resolved,
   * and `fromPartition` runs the first time a non-default WebContents appears.
   */
  readonly resolveSessions: () => SandboxSessions;
}

interface ActiveSandbox {
  readonly lease: McpAppElectronSandboxLease;
  readonly onDestroyed: () => void;
}

/**
 * Subscribes to `web-contents-created` and installs the MCP Apps sandbox
 * policy on every WebContents that lives on the dedicated `mcp-app:thread`
 * partition. The partition session is resolved on demand (memoized) so boot
 * never creates it, and the host window on `defaultSession` is skipped by
 * identity before that resolution can happen.
 */
export function installMcpAppsSandboxStartup(
  options: McpAppsSandboxStartupOptions
): () => Promise<void> {
  const active = new Map<SandboxWebContents, ActiveSandbox>();
  const pendingTeardowns = new Set<Promise<void>>();
  let sandboxSession: SandboxSession | undefined;

  const resolveSandboxSession = (sessions: SandboxSessions): SandboxSession => {
    sandboxSession ??= sessions.fromPartition(MCP_APP_SANDBOX_PARTITION, { cache: false });
    return sandboxSession;
  };

  const trackTeardown = (teardown: Promise<void>): void => {
    pendingTeardowns.add(teardown);
    void teardown.catch(options.onTeardownError).finally(() => pendingTeardowns.delete(teardown));
  };

  const onWebContentsCreated = (_event: ElectronEvent, webContents: WebContents): void => {
    const sessions = options.resolveSessions();
    if (webContents.session === sessions.defaultSession) {
      return;
    }
    if (webContents.session !== resolveSandboxSession(sessions)) {
      return;
    }
    if (active.has(webContents)) {
      return;
    }

    const sandboxWebContents: SandboxWebContents = webContents;
    const lease = installMcpAppElectronSandboxPolicy({
      partition: MCP_APP_SANDBOX_PARTITION,
      sessions,
      webContents: sandboxWebContents,
    });
    const onDestroyed = (): void => {
      webContents.removeListener('destroyed', onDestroyed);
      active.delete(webContents);
      trackTeardown(lease.close());
    };
    active.set(sandboxWebContents, { lease, onDestroyed });
    webContents.on('destroyed', onDestroyed);
  };

  options.app.on('web-contents-created', onWebContentsCreated);

  return async (): Promise<void> => {
    options.app.removeListener('web-contents-created', onWebContentsCreated);
    const closes: Promise<void>[] = [];
    for (const [webContents, sandbox] of active) {
      webContents.removeListener('destroyed', sandbox.onDestroyed);
      closes.push(sandbox.lease.close());
    }
    active.clear();
    const results = await Promise.allSettled([...pendingTeardowns, ...closes]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'MCP Apps sandbox startup teardown failed');
    }
  };
}
