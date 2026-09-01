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
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  setPermissionRequestHandler(
    handler:
      | ((webContents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void)
      | null
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
  const denyDownload = (event: PreventableEvent): void => event.preventDefault();
  for (const event of DENIED_NAVIGATION_EVENTS) {
    options.webContents.on(event, deny);
  }
  options.webContents.on('will-frame-navigate', denyFrameNavigation);
  options.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  options.session.setPermissionCheckHandler(() => false);
  options.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  options.session.on('will-download', denyDownload);

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
      options.session.removeListener('will-download', denyDownload);
      options.session.setPermissionCheckHandler(null);
      options.session.setPermissionRequestHandler(null);
      if (!options.webContents.isDestroyed()) {
        options.webContents.close();
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
