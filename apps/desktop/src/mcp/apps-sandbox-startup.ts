import {
  installMcpAppElectronSandboxPolicy,
  type McpAppElectronSandboxLease,
} from '@brainstrike/mcp-app-host';
import type { App, Event as ElectronEvent, WebContents } from 'electron';

export const MCP_APP_SANDBOX_PARTITION = 'mcp-app:thread' as const;

type SandboxInstallOptions = Parameters<typeof installMcpAppElectronSandboxPolicy>[0];
type SandboxWebContents = WebContents & SandboxInstallOptions['webContents'];

interface McpAppsSandboxStartupOptions {
  readonly app: Pick<App, 'on' | 'removeListener'>;
  readonly onTeardownError: (error: unknown) => void;
  readonly sessions: SandboxInstallOptions['sessions'];
}

interface ActiveSandbox {
  readonly lease: McpAppElectronSandboxLease;
  readonly onDestroyed: () => void;
}

export function installMcpAppsSandboxStartup(
  options: McpAppsSandboxStartupOptions
): () => Promise<void> {
  const active = new Map<SandboxWebContents, ActiveSandbox>();
  const pendingTeardowns = new Set<Promise<void>>();
  const sandboxSession = options.sessions.fromPartition(MCP_APP_SANDBOX_PARTITION, {
    cache: false,
  });

  const trackTeardown = (teardown: Promise<void>): void => {
    pendingTeardowns.add(teardown);
    void teardown.catch(options.onTeardownError).finally(() => pendingTeardowns.delete(teardown));
  };

  const onWebContentsCreated = (_event: ElectronEvent, webContents: WebContents): void => {
    if (webContents.session !== sandboxSession) {
      return;
    }

    const sandboxWebContents: SandboxWebContents = webContents;
    const lease = installMcpAppElectronSandboxPolicy({
      partition: MCP_APP_SANDBOX_PARTITION,
      sessions: options.sessions,
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
