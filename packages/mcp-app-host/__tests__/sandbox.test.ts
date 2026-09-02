import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpAppSandboxPolicy,
  installMcpAppElectronSandboxPolicy,
  McpAppElectronSandboxInstallationError,
  McpAppProvenanceAuthority,
  McpAppSandboxOwner,
  renderMcpAppResourceDocument,
  renderMcpAppSandboxShellDocument,
} from '../src/index.js';

function createOwnedResource(html = '<!doctype html><title>App</title>') {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'alpha' });
  const tool = provenance.registerTool(generation, {
    _meta: { ui: { resourceUri: 'ui://alpha/app' } },
    name: 'app',
  });
  return provenance.resolveResource(generation, tool, {
    _meta: {
      ui: {
        csp: {
          connectDomains: ['https://api.example.com'],
          frameDomains: ['https://frame.example.com'],
          resourceDomains: ['https://cdn.example.com'],
        },
        permissions: { camera: {}, geolocation: {} },
      },
    },
    mimeType: 'text/html;profile=mcp-app',
    text: html,
    uri: 'ui://alpha/app',
  });
}

describe('dedicated MCP Apps sandbox shell', () => {
  it('constructs CSP and permission policy from validated metadata without granting capabilities', () => {
    const policy = buildMcpAppSandboxPolicy(createOwnedResource().meta);

    expect(policy.contentSecurityPolicy).toBe(
      "base-uri 'self'; connect-src https://api.example.com; default-src 'none'; " +
        "font-src https://cdn.example.com; form-action 'none'; " +
        'frame-src https://frame.example.com; img-src data: https://cdn.example.com; ' +
        "media-src data: https://cdn.example.com; object-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.example.com; " +
        "style-src 'unsafe-inline' https://cdn.example.com; worker-src 'none'"
    );
    expect(policy.contentSecurityPolicy).not.toContain('unsafe-eval');
    expect(policy.permissionsPolicy).toBe(
      'camera=(), clipboard-write=(), geolocation=(), microphone=()'
    );
    expect(policy.iframeAllow).toBe(
      "camera 'none'; clipboard-write 'none'; geolocation 'none'; microphone 'none'"
    );
    expect(policy.requestedPermissions).toEqual(['camera', 'geolocation']);
    expect(policy.sandbox).toBe('allow-scripts');
  });

  it('does not grant data fonts when resource domains are undeclared', () => {
    const policy = buildMcpAppSandboxPolicy(undefined);

    expect(policy.contentSecurityPolicy).toBe(
      "base-uri 'self'; connect-src 'none'; default-src 'none'; form-action 'none'; " +
        "frame-src 'none'; img-src data:; media-src data:; object-src 'none'; " +
        "script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'"
    );
    expect(policy.contentSecurityPolicy).not.toContain('font-src data:');
  });

  it('renders self-contained shell and resource documents with no escape sandbox tokens', () => {
    const resource = createOwnedResource();
    const policy = buildMcpAppSandboxPolicy(resource.meta);
    const resourceDocument = renderMcpAppResourceDocument(resource, policy);
    const shell = renderMcpAppSandboxShellDocument(resourceDocument, policy);
    // Every `<` of the embedded app is escaped, so neither `</script>` nor
    // `<!--` can end or swallow the bootstrap script.
    const hostile = renderMcpAppSandboxShellDocument(
      renderMcpAppResourceDocument(
        createOwnedResource('<!doctype html><!-- x --><script>1</script><title>A</title>'),
        policy
      ),
      policy
    );
    const bootstrap = hostile.slice(hostile.indexOf('<body><script>') + '<body><script>'.length);
    expect(bootstrap.indexOf('<')).toBe(bootstrap.indexOf('</script></body></html>'));
    expect(bootstrap).toContain(String.raw`\x3c!--`);

    expect(resourceDocument.indexOf('Content-Security-Policy')).toBeLessThan(
      resourceDocument.indexOf('<title>App')
    );
    // Host-owned doctype: standards mode with the CSP still ahead of app bytes.
    expect(
      resourceDocument.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')
    ).toBe(true);
    expect(resourceDocument.match(/<!doctype/giu)).toHaveLength(1);
    expect(
      renderMcpAppResourceDocument(createOwnedResource('<title>Bare</title>'), policy).startsWith(
        '<!doctype html><meta http-equiv="Content-Security-Policy"'
      )
    ).toBe(true);
    // The srcdoc app inherits the shell policy, so the shell carries it verbatim.
    expect(shell).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${policy.contentSecurityPolicy.replace(/'/g, "'")}">`
    );
    expect(shell).not.toContain("frame-src 'self'");
    expect(shell).toContain("setAttribute('sandbox','allow-scripts')");
    expect(shell).toContain("setAttribute('referrerpolicy','no-referrer')");
    expect(shell).toContain('frame.srcdoc=');
    expect(shell).not.toContain('allow-same-origin');
    expect(shell).not.toContain('allow-downloads');
    expect(shell).not.toContain('allow-popups');
    expect(shell).not.toContain('allow-top-navigation');
    expect(shell).not.toContain('window.open');
  });
});

describe('MCP Apps object URL and memory ownership', () => {
  it('owns the shell URL and releases every byte and URL exactly once', async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 2, maxRetainedBytes: 4096 },
      urls: {
        createObjectURL: (blob) => {
          created.push(blob);
          return `blob:test/${created.length}`;
        },
        revokeObjectURL: (url) => revoked.push(url),
      },
    });

    const mount = owner.open(createOwnedResource());
    expect(mount.shellUrl).toBe('blob:test/1');
    expect(owner.activeFrames).toBe(1);
    expect(owner.retainedBytes).toBeGreaterThan(0);
    await mount.close();
    await mount.close();
    expect(revoked).toEqual(['blob:test/1']);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);
  });

  it('retains URL and memory ownership until a failed revocation succeeds on retry', async () => {
    let revokeAttempts = 0;
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      urls: {
        createObjectURL: () => 'blob:retryable/1',
        revokeObjectURL: () => {
          revokeAttempts += 1;
          if (revokeAttempts === 1) {
            throw new Error('revoke failed');
          }
        },
      },
    });
    const mount = owner.open(createOwnedResource());
    const retainedBytes = owner.retainedBytes;

    await expect(mount.close()).rejects.toThrow('revoke failed');
    expect(owner.activeFrames).toBe(1);
    expect(owner.retainedBytes).toBe(retainedBytes);

    await expect(mount.close()).resolves.toBeUndefined();
    expect(revokeAttempts).toBe(2);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);
  });

  it('fails closed on frame/memory limits and leaves failed allocations unowned', async () => {
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      urls: {
        createObjectURL: () => {
          throw new Error('shell allocation failed');
        },
        revokeObjectURL: vi.fn(),
      },
    });

    expect(() => owner.open(createOwnedResource())).toThrow(/shell allocation failed/);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);

    let allocation = 0;
    const stable = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      urls: {
        createObjectURL: (blob) => {
          allocation += 1;
          return `blob:stable/${blob.size}/${allocation}`;
        },
        revokeObjectURL: vi.fn(),
      },
    });
    stable.open(createOwnedResource());
    expect(() => stable.open(createOwnedResource())).toThrow(/active frame limit/);
    await stable.closeAll();
  });
});

type Listener = (event: { isMainFrame?: boolean; preventDefault(): void; url?: string }) => void;

/**
 * Models Electron: `close()` is asynchronous, so `isDestroyed()` flips and the
 * 'destroyed' listeners fire on a later microtask unless `destroySync`.
 */
function createWebContents(options: { destroySync?: boolean; failCloses?: number } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  let destroyed = false;
  let closeAttempts = 0;
  const emit = (event: string): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener({ preventDefault: () => undefined });
    }
  };
  const destroy = (): void => {
    destroyed = true;
    emit('destroyed');
  };
  const webContents = {
    close: vi.fn(() => {
      closeAttempts += 1;
      if (closeAttempts <= (options.failCloses ?? 0)) {
        throw new Error('web contents close failed');
      }
      if (options.destroySync) {
        destroy();
      } else {
        queueMicrotask(destroy);
      }
    }),
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    setWindowOpenHandler: vi.fn(),
  };
  const installed = (): string[] =>
    [...listeners.entries()].filter(([, set]) => set.size > 0).map(([event]) => event);
  return { closeAttempts: () => closeAttempts, emit, installed, listeners, webContents };
}

function createSession(options: { failDownloadHook?: boolean } = {}) {
  const sessionListeners = new Map<string, Listener>();
  const permissionChecks: Array<() => boolean> = [];
  const permissionRequests: Array<
    (webContents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void
  > = [];
  const session = {
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: Listener) => {
      if (options.failDownloadHook) {
        throw new Error('download hook failed');
      }
      sessionListeners.set(event, listener);
    }),
    removeListener: vi.fn((event: string) => sessionListeners.delete(event)),
    setPermissionCheckHandler: vi.fn((handler: () => boolean) => {
      permissionChecks.push(handler);
    }),
    setPermissionRequestHandler: vi.fn(
      (
        handler: (
          webContents: unknown,
          permission: unknown,
          callback: (allowed: boolean) => void
        ) => void
      ) => {
        permissionRequests.push(handler);
      }
    ),
  };
  return { permissionChecks, permissionRequests, session, sessionListeners };
}

function install(session: ReturnType<typeof createSession>['session'], webContents: unknown) {
  return installMcpAppElectronSandboxPolicy({
    partition: 'mcp-app:unit',
    sessions: { fromPartition: () => session },
    webContents: webContents as Parameters<
      typeof installMcpAppElectronSandboxPolicy
    >[0]['webContents'],
  });
}

describe('Electron sandbox denial hooks', () => {
  it('denies navigation, popups, downloads, external opening, webviews, and permissions', async () => {
    const wc = createWebContents();
    const { permissionChecks, permissionRequests, session, sessionListeners } = createSession();
    const sessions = { fromPartition: vi.fn(() => session) };
    for (const partition of ['persist:mcp-app:unit', 'default', 'mcp-app:', 'mcp-app:bad name']) {
      expect(() =>
        installMcpAppElectronSandboxPolicy({ partition, sessions, webContents: wc.webContents })
      ).toThrow(/dedicated non-persistent/);
    }
    expect(sessions.fromPartition).not.toHaveBeenCalled();
    const lease = installMcpAppElectronSandboxPolicy({
      partition: 'mcp-app:unit',
      sessions,
      webContents: wc.webContents,
    });
    expect(sessions.fromPartition).toHaveBeenCalledWith('mcp-app:unit', { cache: false });

    expect(wc.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
    const openHandler = wc.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown;
    expect(openHandler()).toEqual({ action: 'deny' });
    for (const event of ['will-attach-webview', 'will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn();
      for (const listener of wc.listeners.get(event) ?? []) {
        listener({ preventDefault });
      }
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventFrameNavigation = vi.fn();
    for (const listener of wc.listeners.get('will-frame-navigate') ?? []) {
      listener({
        isMainFrame: true,
        preventDefault: preventFrameNavigation,
        url: 'https://escape.invalid',
      });
    }
    expect(preventFrameNavigation).toHaveBeenCalledOnce();
    const allowSrcdoc = vi.fn();
    for (const listener of wc.listeners.get('will-frame-navigate') ?? []) {
      listener({ isMainFrame: false, preventDefault: allowSrcdoc, url: 'about:srcdoc' });
    }
    expect(allowSrcdoc).not.toHaveBeenCalled();
    const preventDownload = vi.fn();
    sessionListeners.get('will-download')?.({ preventDefault: preventDownload });
    expect(preventDownload).toHaveBeenCalledOnce();
    expect(permissionChecks[0]?.()).toBe(false);
    const permissionResult = vi.fn();
    permissionRequests[0]?.({}, 'camera', permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);

    // A second lease on the same session shares the session denials.
    const siblingWc = createWebContents();
    const sibling = install(session, siblingWc.webContents);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();

    await lease.close();
    expect(wc.webContents.close).toHaveBeenCalledOnce();
    // Per-WebContents hooks are released only after destruction; session
    // denials are never restored and a live sibling's storage is untouched.
    expect(wc.installed()).toEqual([]);
    expect(permissionChecks.at(-1)?.()).toBe(false);
    expect(sessionListeners.get('will-download')).toBeDefined();
    expect(session.clearStorageData).not.toHaveBeenCalled();

    await sibling.close();
    expect(siblingWc.installed()).toEqual([]);
    expect(session.clearCache).toHaveBeenCalledOnce();
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(sessionListeners.get('will-download')).toBeDefined();
  });

  it('keeps deny listeners installed until the WebContents is destroyed', async () => {
    const wc = createWebContents();
    const { session } = createSession();
    const lease = install(session, wc.webContents);
    const closing = lease.close();
    // close() was requested but destruction is still pending: hooks stay.
    expect(wc.webContents.close).toHaveBeenCalledOnce();
    expect(wc.installed()).toContain('will-navigate');
    await closing;
    expect(wc.installed()).toEqual([]);
  });

  it('rolls back every per-WebContents listener when installation fails and keeps session denials', async () => {
    const wc = createWebContents({ destroySync: true });
    const { permissionChecks, permissionRequests, session } = createSession({
      failDownloadHook: true,
    });

    expect(() => install(session, wc.webContents)).toThrow(McpAppElectronSandboxInstallationError);
    expect(wc.installed()).toEqual([]);
    expect(wc.webContents.close).toHaveBeenCalledOnce();
    // Session denials installed before the failure are fail-closed and stay.
    expect(permissionChecks).toHaveLength(1);
    expect(permissionRequests).toHaveLength(1);
    expect(session.removeListener).not.toHaveBeenCalled();

    // A retry installs only the missing session hook.
    session.on.mockImplementation((event: string) => {
      expect(event).toBe('will-download');
    });
    const retryWc = createWebContents();
    const lease = install(session, retryWc.webContents);
    expect(permissionChecks).toHaveLength(1);
    expect(permissionRequests).toHaveLength(1);
    expect(session.on).toHaveBeenCalledTimes(2);
    await lease.close();
  });

  it('coalesces concurrent closes, retries every owed step, and purges in parallel once closed', async () => {
    const wc = createWebContents({ failCloses: 1 });
    const { session } = createSession();
    let cacheClearAttempts = 0;
    session.clearCache.mockImplementation(async () => {
      cacheClearAttempts += 1;
      if (cacheClearAttempts === 1) {
        throw new Error('cache clear failed');
      }
    });
    const lease = install(session, wc.webContents);

    const first = lease.close();
    const second = lease.close();
    expect(second).toBe(first);
    const failure = await first.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'web contents close failed' }),
      expect.objectContaining({ message: 'cache clear failed' }),
    ]);
    expect(session.clearCache).toHaveBeenCalledOnce();
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    // Per-WebContents hooks stay installed while the WebContents is still alive.
    expect(wc.installed()).toContain('will-navigate');

    await expect(lease.close()).resolves.toBeUndefined();
    expect(wc.webContents.close).toHaveBeenCalledTimes(2);
    expect(session.clearCache).toHaveBeenCalledTimes(2);
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(wc.installed()).toEqual([]);
    expect(session.removeListener).not.toHaveBeenCalled();

    await expect(lease.close()).resolves.toBeUndefined();
    expect(wc.webContents.close).toHaveBeenCalledTimes(2);
  });

  it('yields a retried purge to a replacement lease that acquired the session', async () => {
    const wc = createWebContents();
    const { session } = createSession();
    session.clearStorageData.mockRejectedValueOnce(new Error('storage clear failed'));
    const lease = install(session, wc.webContents);
    await expect(lease.close()).rejects.toThrow(/teardown failed/);
    expect(session.clearStorageData).toHaveBeenCalledOnce();

    const replacementWc = createWebContents();
    const replacement = install(session, replacementWc.webContents);
    await expect(lease.close()).resolves.toBeUndefined();
    // The retried close did not purge the session the replacement now owns.
    expect(session.clearStorageData).toHaveBeenCalledOnce();
    expect(session.clearCache).toHaveBeenCalledOnce();

    await replacement.close();
    expect(session.clearStorageData).toHaveBeenCalledTimes(2);
    expect(session.clearCache).toHaveBeenCalledTimes(2);
  });

  it('returns retryable cleanup ownership when installation and WebContents close both fail', async () => {
    const wc = createWebContents({ failCloses: 1 });
    const { session } = createSession({ failDownloadHook: true });

    let installationFailure: unknown;
    try {
      install(session, wc.webContents);
    } catch (error: unknown) {
      installationFailure = error;
    }
    if (!(installationFailure instanceof McpAppElectronSandboxInstallationError)) {
      throw new Error('expected a retryable sandbox installation failure');
    }
    expect(installationFailure.errors).toEqual([
      expect.objectContaining({ message: 'download hook failed' }),
      expect.objectContaining({ message: 'web contents close failed' }),
    ]);
    expect(wc.closeAttempts()).toBe(1);
    expect(wc.installed()).toHaveLength(4);

    await installationFailure.cleanup.close();

    expect(wc.closeAttempts()).toBe(2);
    expect(wc.installed()).toEqual([]);
    // The lease never held the session, so no purge is owed.
    expect(session.clearCache).not.toHaveBeenCalled();
    expect(session.clearStorageData).not.toHaveBeenCalled();
  });
});
