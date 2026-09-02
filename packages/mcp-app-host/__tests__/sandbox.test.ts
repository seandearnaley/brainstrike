import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpAppSandboxPolicy,
  installMcpAppElectronSandboxPolicy,
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

describe('Electron sandbox denial hooks', () => {
  it('denies navigation, popups, downloads, external opening, webviews, and permissions', async () => {
    const listeners = new Map<
      string,
      (event: { isMainFrame?: boolean; preventDefault(): void; url?: string }) => void
    >();
    const sessionListeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const permissionRequests: Array<((callback: (allowed: boolean) => void) => void) | null> = [];
    const permissionChecks: Array<(() => boolean) | null> = [];
    const openHandlers: Array<() => { action: 'deny' }> = [];
    const webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(
        (
          event: string,
          listener: (event: { isMainFrame?: boolean; preventDefault(): void; url?: string }) => void
        ) => {
          listeners.set(event, listener);
        }
      ),
      removeListener: vi.fn((event: string) => listeners.delete(event)),
      setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
        openHandlers.push(handler);
      }),
    };
    const sandboxSession = {
      clearCache: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: (event: { preventDefault(): void }) => void) => {
        sessionListeners.set(event, listener);
      }),
      removeListener: vi.fn((event: string) => sessionListeners.delete(event)),
      setPermissionCheckHandler: vi.fn((handler: (() => boolean) | null) => {
        permissionChecks.push(handler);
      }),
      setPermissionRequestHandler: vi.fn(
        (
          handler: ((_: unknown, __: unknown, callback: (allowed: boolean) => void) => void) | null
        ) => {
          permissionRequests.push(
            handler === null ? null : (callback) => handler({}, 'camera', callback)
          );
        }
      ),
    };
    const sessions = { fromPartition: vi.fn(() => sandboxSession) };
    for (const partition of ['persist:mcp-app:unit', 'default', 'mcp-app:', 'mcp-app:bad name']) {
      expect(() =>
        installMcpAppElectronSandboxPolicy({ partition, sessions, webContents })
      ).toThrow(/dedicated non-persistent/);
    }
    expect(sessions.fromPartition).not.toHaveBeenCalled();
    const lease = installMcpAppElectronSandboxPolicy({
      partition: 'mcp-app:unit',
      sessions,
      webContents,
    });
    expect(sessions.fromPartition).toHaveBeenCalledWith('mcp-app:unit', { cache: false });

    expect(openHandlers[0]?.()).toEqual({ action: 'deny' });
    for (const event of ['will-attach-webview', 'will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn();
      listeners.get(event)?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventFrameNavigation = vi.fn();
    listeners.get('will-frame-navigate')?.({
      isMainFrame: true,
      preventDefault: preventFrameNavigation,
      url: 'https://escape.invalid',
    });
    expect(preventFrameNavigation).toHaveBeenCalledOnce();
    const allowSrcdoc = vi.fn();
    listeners.get('will-frame-navigate')?.({
      isMainFrame: false,
      preventDefault: allowSrcdoc,
      url: 'about:srcdoc',
    });
    expect(allowSrcdoc).not.toHaveBeenCalled();
    const preventDownload = vi.fn();
    sessionListeners.get('will-download')?.({ preventDefault: preventDownload });
    expect(preventDownload).toHaveBeenCalledOnce();
    expect(permissionChecks[0]?.()).toBe(false);
    const permissionResult = vi.fn();
    permissionRequests[0]?.(permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);

    // A second lease on the same session shares the session denials.
    const sibling = installMcpAppElectronSandboxPolicy({
      partition: 'mcp-app:unit',
      sessions,
      webContents,
    });
    expect(sandboxSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(sandboxSession.setPermissionRequestHandler).toHaveBeenCalledOnce();

    await lease.close();
    expect(webContents.close).toHaveBeenCalledOnce();
    // Closing one lease never restores Electron's permissive defaults and does
    // not purge the storage a live sibling still uses.
    expect(permissionChecks).not.toContain(null);
    expect(permissionRequests).not.toContain(null);
    expect(permissionChecks.at(-1)?.()).toBe(false);
    expect(sessionListeners.get('will-download')).toBeDefined();
    expect(sandboxSession.clearStorageData).not.toHaveBeenCalled();

    await sibling.close();
    expect(listeners.size).toBe(0);
    expect(sandboxSession.clearCache).toHaveBeenCalledOnce();
    expect(sandboxSession.clearStorageData).toHaveBeenCalledOnce();
    expect(permissionChecks).not.toContain(null);
    expect(sessionListeners.get('will-download')).toBeDefined();
  });
});
