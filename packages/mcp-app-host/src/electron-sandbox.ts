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

interface McpAppElectronSessions {
  fromPartition(partition: string, options: { cache: false }): McpAppElectronSession;
}

interface McpAppElectronSandboxOptions {
  /** Dedicated in-memory partition, `mcp-app:<name>`; never `persist:` or the default session. */
  readonly partition: string;
  readonly sessions: McpAppElectronSessions;
  readonly webContents: McpAppElectronWebContents;
}

/**
 * Teardown clears the session's cache and storage, so the session must be one
 * this policy owns: it is created here from a dedicated, non-persistent
 * `mcp-app:` partition (the same string the caller gives its WebContents), so
 * `defaultSession` or another feature's partition can never be cleared.
 */
const OWNED_PARTITION = /^mcp-app:[A-Za-z0-9._~-]{1,128}$/u;

export function requireMcpAppSandboxPartition(partition: string): string {
  if (!OWNED_PARTITION.test(partition)) {
    throw new TypeError(
      'MCP Apps sandbox partition must be a dedicated non-persistent "mcp-app:<name>" partition'
    );
  }
  return partition;
}

export interface McpAppElectronSandboxLease {
  close(): Promise<void>;
}

/**
 * Thrown when installation fails part-way. `cleanup` owns whatever was
 * installed (and the WebContents) so the caller can retry teardown until it
 * succeeds instead of leaking a half-installed sandbox.
 */
export class McpAppElectronSandboxInstallationError extends AggregateError {
  readonly cleanup: McpAppElectronSandboxLease;

  constructor(errors: readonly unknown[], cleanup: McpAppElectronSandboxLease) {
    const primary = errors[0];
    const detail = primary instanceof Error ? `: ${primary.message}` : '';
    super(errors, `MCP Apps Electron sandbox installation failed${detail}`);
    this.name = 'McpAppElectronSandboxInstallationError';
    this.cleanup = cleanup;
  }
}

const DENIED_NAVIGATION_EVENTS = ['will-attach-webview', 'will-navigate', 'will-redirect'] as const;

interface CleanupTask {
  readonly run: () => void;
}

/**
 * Session hooks (permission handlers, download denial) are session-scoped, not
 * WebContents-scoped, and passing `null` to the permission setters restores
 * Electron's permissive defaults. They are therefore installed once per
 * session and never removed: a sandbox session stays denied for its lifetime,
 * so closing one lease cannot fail another lease open, and a reused partition
 * never starts permissive. Each hook is tracked individually so a failed
 * install retries only the missing ones. Leases are ref-counted per session
 * and only the last lease's teardown purges cache and storage.
 */
interface SessionDenialState {
  download: boolean;
  leases: number;
  permissionCheck: boolean;
  permissionRequest: boolean;
}

const SESSION_STATE = new WeakMap<McpAppElectronSession, SessionDenialState>();

function sessionState(session: McpAppElectronSession): SessionDenialState {
  let state = SESSION_STATE.get(session);
  if (state === undefined) {
    state = { download: false, leases: 0, permissionCheck: false, permissionRequest: false };
    SESSION_STATE.set(session, state);
  }
  return state;
}

function acquireSessionLease(session: McpAppElectronSession): void {
  const state = sessionState(session);
  if (!state.permissionCheck) {
    session.setPermissionCheckHandler(() => false);
    state.permissionCheck = true;
  }
  if (!state.permissionRequest) {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    state.permissionRequest = true;
  }
  if (!state.download) {
    session.on('will-download', (event) => event.preventDefault());
    state.download = true;
  }
  state.leases += 1;
}

/** Returns whether the released lease was the session's last one. */
function releaseSessionLease(session: McpAppElectronSession): boolean {
  const state = sessionState(session);
  if (state.leases < 1) {
    throw new Error('MCP Apps Electron sandbox session lease accounting is corrupt');
  }
  state.leases -= 1;
  return state.leases === 0;
}

function attempt(operation: () => void, errors: unknown[], onSuccess?: () => void): void {
  try {
    operation();
    onSuccess?.();
  } catch (error: unknown) {
    errors.push(error);
  }
}

function closeWebContents(webContents: McpAppElectronWebContents, errors: unknown[]): boolean {
  let destroyed = false;
  attempt(() => {
    destroyed = webContents.isDestroyed();
  }, errors);
  if (destroyed) {
    return true;
  }
  let closeCompleted = false;
  attempt(
    () => webContents.close(),
    errors,
    () => {
      closeCompleted = true;
    }
  );
  return closeCompleted;
}

function releaseCleanupTasks(tasks: CleanupTask[], errors: unknown[]): void {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    if (task === undefined) {
      continue;
    }
    attempt(task.run, errors, () => {
      tasks.splice(index, 1);
    });
  }
}

interface LeaseState {
  holdsSessionLease: boolean;
  webContentsClosed: boolean;
}

interface PurgeState {
  cacheCleared: boolean;
  storageCleared: boolean;
}

async function purgeSession(
  session: McpAppElectronSession,
  purge: PurgeState,
  errors: unknown[]
): Promise<void> {
  if (!purge.cacheCleared) {
    try {
      await session.clearCache();
      purge.cacheCleared = true;
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  if (!purge.storageCleared) {
    try {
      await session.clearStorageData();
      purge.storageCleared = true;
    } catch (error: unknown) {
      errors.push(error);
    }
  }
}

/**
 * Teardown is retryable: every step records its own success, a failed step is
 * retried on the next `close()`, every failure is reported in one
 * `AggregateError`, and the lease counts as closed only once every owed step
 * has succeeded. Per-WebContents hooks are released only after the
 * WebContents is closed so a live frame never runs without them. The session
 * lease is released on the first attempt; when it was the session's last
 * lease, cache and storage are purged (retried until they succeed).
 */
function createSandboxLease(
  webContents: McpAppElectronWebContents,
  session: McpAppElectronSession,
  cleanupTasks: CleanupTask[],
  initial: LeaseState
): McpAppElectronSandboxLease {
  let closed = false;
  let webContentsClosed = initial.webContentsClosed;
  let holdsSessionLease = initial.holdsSessionLease;
  let purgeOwed = false;
  const purge: PurgeState = { cacheCleared: false, storageCleared: false };
  return Object.freeze({
    close: async () => {
      if (closed) {
        return;
      }
      const errors: unknown[] = [];
      if (!webContentsClosed) {
        webContentsClosed = closeWebContents(webContents, errors);
      }
      if (webContentsClosed) {
        releaseCleanupTasks(cleanupTasks, errors);
      }
      if (holdsSessionLease) {
        holdsSessionLease = false;
        purgeOwed = releaseSessionLease(session);
      }
      if (purgeOwed) {
        await purgeSession(session, purge, errors);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'MCP Apps Electron sandbox teardown failed');
      }
      closed =
        cleanupTasks.length === 0 &&
        webContentsClosed &&
        (!purgeOwed || (purge.cacheCleared && purge.storageCleared));
    },
  });
}

/**
 * Installation is failure-atomic: a partial hook registration closes the
 * dedicated WebContents and rolls back every per-WebContents listener; the
 * session denials installed so far stay (they are fail-closed by design).
 * When rollback itself fails, the thrown `McpAppElectronSandboxInstallationError`
 * carries a `cleanup` lease that retains ownership for retry.
 */
export function installMcpAppElectronSandboxPolicy(
  options: McpAppElectronSandboxOptions
): McpAppElectronSandboxLease {
  const session = options.sessions.fromPartition(requireMcpAppSandboxPartition(options.partition), {
    cache: false,
  });
  const deny = (event: PreventableEvent): void => event.preventDefault();
  const denyFrameNavigation = (event: PreventableEvent): void => {
    if (event.isMainFrame === false && event.url === 'about:srcdoc') {
      return;
    }
    event.preventDefault();
  };
  const cleanupTasks: CleanupTask[] = [];
  let holdsSessionLease = false;
  try {
    for (const event of DENIED_NAVIGATION_EVENTS) {
      options.webContents.on(event, deny);
      cleanupTasks.push({ run: () => options.webContents.removeListener(event, deny) });
    }
    options.webContents.on('will-frame-navigate', denyFrameNavigation);
    cleanupTasks.push({
      run: () => options.webContents.removeListener('will-frame-navigate', denyFrameNavigation),
    });
    options.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    acquireSessionLease(session);
    holdsSessionLease = true;
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = [];
    const webContentsClosed = closeWebContents(options.webContents, rollbackErrors);
    if (webContentsClosed) {
      releaseCleanupTasks(cleanupTasks, rollbackErrors);
    }
    throw new McpAppElectronSandboxInstallationError(
      [error, ...rollbackErrors],
      createSandboxLease(options.webContents, session, cleanupTasks, {
        holdsSessionLease,
        webContentsClosed,
      })
    );
  }
  return createSandboxLease(options.webContents, session, cleanupTasks, {
    holdsSessionLease,
    webContentsClosed: false,
  });
}
