interface PreventableEvent {
  readonly isMainFrame?: boolean;
  preventDefault(): void;
  readonly url?: string;
}

type EventListener = (event: PreventableEvent) => void;

interface McpAppElectronWebContents {
  close(): void;
  isDestroyed(): boolean;
  on(event: string, listener: EventListener): void;
  removeListener(event: string, listener: EventListener): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

interface McpAppElectronSession {
  clearCache(): Promise<void>;
  clearStorageData(): Promise<void>;
  on(event: string, listener: EventListener): void;
  removeListener(event: string, listener: EventListener): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: unknown,
      callback: (allowed: boolean) => void
    ) => void
  ): void;
}

interface McpAppElectronSandboxOptions {
  readonly session: McpAppElectronSession;
  readonly webContents: McpAppElectronWebContents;
}

export interface McpAppElectronSandboxLease {
  close(): Promise<void>;
}

const DENIED_NAVIGATION_EVENTS = ['will-attach-webview', 'will-navigate', 'will-redirect'] as const;

/**
 * Session hooks (permission handlers, download denial) are session-scoped, not
 * WebContents-scoped, and passing `null` to the permission setters restores
 * Electron's permissive defaults. They are therefore installed once per
 * session and never removed: a sandbox session stays denied for its lifetime,
 * so closing one lease cannot fail another lease open, and a reused partition
 * never starts permissive. Only the per-session storage purge waits for the
 * last lease.
 */
const SESSION_LEASES = new WeakMap<McpAppElectronSession, number>();

function installSessionDenials(session: McpAppElectronSession): void {
  const leases = SESSION_LEASES.get(session) ?? 0;
  SESSION_LEASES.set(session, leases + 1);
  if (leases > 0) {
    return;
  }
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.on('will-download', (event) => event.preventDefault());
}

function releaseSessionLease(session: McpAppElectronSession): boolean {
  const leases = SESSION_LEASES.get(session);
  if (leases === undefined || leases < 1) {
    throw new Error('MCP Apps Electron sandbox session lease accounting is corrupt');
  }
  SESSION_LEASES.set(session, leases - 1);
  return leases === 1;
}

export function installMcpAppElectronSandboxPolicy(
  options: McpAppElectronSandboxOptions
): McpAppElectronSandboxLease {
  const deny = (event: PreventableEvent): void => event.preventDefault();
  const denyFrameNavigation = (event: PreventableEvent): void => {
    if (event.isMainFrame === false && event.url === 'about:srcdoc') {
      return;
    }
    event.preventDefault();
  };
  for (const event of DENIED_NAVIGATION_EVENTS) {
    options.webContents.on(event, deny);
  }
  options.webContents.on('will-frame-navigate', denyFrameNavigation);
  options.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  installSessionDenials(options.session);

  let closed = false;
  return Object.freeze({
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const event of DENIED_NAVIGATION_EVENTS) {
        options.webContents.removeListener(event, deny);
      }
      options.webContents.removeListener('will-frame-navigate', denyFrameNavigation);
      const lastLease = releaseSessionLease(options.session);
      if (!options.webContents.isDestroyed()) {
        options.webContents.close();
      }
      if (!lastLease) {
        return;
      }
      const results = await Promise.allSettled([
        options.session.clearCache(),
        options.session.clearStorageData(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'MCP Apps Electron sandbox teardown failed');
      }
    },
  });
}
