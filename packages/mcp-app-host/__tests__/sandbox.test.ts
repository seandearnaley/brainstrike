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

    expect(policy.contentSecurityPolicy).toContain("default-src 'none'");
    expect(policy.contentSecurityPolicy).toContain('connect-src https://api.example.com');
    expect(policy.contentSecurityPolicy).toContain('frame-src https://frame.example.com');
    expect(policy.contentSecurityPolicy).toContain(
      "script-src 'unsafe-inline' https://cdn.example.com"
    );
    expect(policy.contentSecurityPolicy).toContain("object-src 'none'");
    expect(policy.contentSecurityPolicy).toContain("worker-src 'none'");
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

  it('renders self-contained shell and resource documents with no escape sandbox tokens', () => {
    const resource = createOwnedResource();
    const policy = buildMcpAppSandboxPolicy(resource.meta);
    const resourceDocument = renderMcpAppResourceDocument(resource, policy);
    const shell = renderMcpAppSandboxShellDocument(resourceDocument, policy);

    expect(resourceDocument.indexOf('Content-Security-Policy')).toBeLessThan(
      resourceDocument.indexOf('<title>App')
    );
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
    const lease = installMcpAppElectronSandboxPolicy({ session: sandboxSession, webContents });

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

    await lease.close();
    expect(webContents.close).toHaveBeenCalledOnce();
    expect(sandboxSession.clearCache).toHaveBeenCalledOnce();
    expect(sandboxSession.clearStorageData).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(sessionListeners.size).toBe(0);
    expect(permissionChecks.at(-1)).toBeNull();
    expect(permissionRequests.at(-1)).toBeNull();
  });
});
