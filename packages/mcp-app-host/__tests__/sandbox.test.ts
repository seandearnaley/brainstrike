import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpAppSandboxPolicy,
  McpAppProvenanceAuthority,
  McpAppSandboxOwner,
  type McpAppSandboxShellHost,
  renderMcpAppResourceDocument,
  renderMcpAppSandboxShell,
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
    // The srcdoc app inherits the shell policy as a HEADER the serving host
    // delivers verbatim; the shell document itself carries no meta policy
    // (Permissions-Policy is header-only, and a meta CSP would be a second,
    // weaker delivery path the app could not inherit).
    const shellHead = shell.slice(0, shell.indexOf('<body>'));
    expect(shellHead).not.toContain('Content-Security-Policy');
    expect(shellHead).not.toContain('Permissions-Policy');
    const served = renderMcpAppSandboxShell(resource);
    expect(served).toEqual({
      contentSecurityPolicy: policy.contentSecurityPolicy,
      document: shell,
      permissionsPolicy: policy.permissionsPolicy,
    });
    expect(Object.isFrozen(served)).toBe(true);
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

function createShellHost(options: { failPrepare?: boolean; failReleases?: number } = {}) {
  const prepared: string[] = [];
  const released: string[] = [];
  let releaseAttempts = 0;
  const shellHost: McpAppSandboxShellHost = {
    prepareShell: vi.fn(async (shell) => {
      if (options.failPrepare) {
        throw new Error('shell registration failed');
      }
      const token = (prepared.length + 1).toString(16).padStart(32, '0');
      prepared.push(shell.document);
      return { shellUrl: `brainstrike-mcp-app://${token}/`, token };
    }),
    releaseShell: vi.fn(async ({ token }) => {
      releaseAttempts += 1;
      if (releaseAttempts <= (options.failReleases ?? 0)) {
        throw new Error('release failed');
      }
      released.push(token);
    }),
  };
  return { prepared, releaseAttempts: () => releaseAttempts, released, shellHost };
}

describe('MCP Apps shell ownership', () => {
  it('registers the served shell with its header policies and releases every byte and shell exactly once', async () => {
    const host = createShellHost();
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 2, maxRetainedBytes: 4096 },
      shellHost: host.shellHost,
    });
    const resource = createOwnedResource();

    const mount = await owner.open(resource);
    expect(mount.shellUrl).toBe(`brainstrike-mcp-app://${'1'.padStart(32, '0')}/`);
    expect(host.shellHost.prepareShell).toHaveBeenCalledWith(renderMcpAppSandboxShell(resource));
    expect(owner.activeFrames).toBe(1);
    expect(owner.retainedBytes).toBeGreaterThan(0);
    await mount.close();
    await mount.close();
    expect(host.released).toEqual(['1'.padStart(32, '0')]);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);
  });

  it('retains shell and memory ownership until a failed release succeeds on retry', async () => {
    const host = createShellHost({ failReleases: 1 });
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      shellHost: host.shellHost,
    });
    const mount = await owner.open(createOwnedResource());
    const retainedBytes = owner.retainedBytes;

    await expect(mount.close()).rejects.toThrow('release failed');
    expect(owner.activeFrames).toBe(1);
    expect(owner.retainedBytes).toBe(retainedBytes);

    await expect(mount.close()).resolves.toBeUndefined();
    expect(host.releaseAttempts()).toBe(2);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);
  });

  it('fails closed on frame/memory limits, reserves budget across in-flight registrations, and owns nothing after a failed registration', async () => {
    const failing = createShellHost({ failPrepare: true });
    const owner = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      shellHost: failing.shellHost,
    });
    await expect(owner.open(createOwnedResource())).rejects.toThrow(/shell registration failed/);
    expect(owner.activeFrames).toBe(0);
    expect(owner.retainedBytes).toBe(0);

    const host = createShellHost();
    const stable = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 1, maxRetainedBytes: 4096 },
      shellHost: host.shellHost,
    });
    // Two concurrent opens: the second is rejected while the first is still registering.
    const first = stable.open(createOwnedResource());
    await expect(stable.open(createOwnedResource())).rejects.toThrow(/active frame limit/);
    await first;
    expect(stable.activeFrames).toBe(1);
    await stable.closeAll();
    expect(stable.activeFrames).toBe(0);

    const tiny = new McpAppSandboxOwner({
      limits: { maxActiveFrames: 4, maxRetainedBytes: 16 },
      shellHost: host.shellHost,
    });
    await expect(tiny.open(createOwnedResource())).rejects.toThrow(/retained memory limit/);
    expect(host.shellHost.prepareShell).toHaveBeenCalledTimes(1);
  });
});
