import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import {
  createMcpAppShellProtocolHandler,
  MCP_APP_SHELL_PROTOCOL_SCHEME,
  McpAppShellRegistry,
  mcpAppShellUrl,
} from '../../mcp/apps-shell-protocol';

const SHELL = Object.freeze({
  contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'",
  document: '<!doctype html><title>shell</title>',
  permissionsPolicy: 'camera=(), geolocation=()',
});

/**
 * The brainstrike-mcp-app:// protocol serves registered MCP App sandbox shells
 * ONLY (BST-1572). Each response carries the per-app CSP and Permissions-Policy
 * as REAL headers (the nested srcdoc app frame inherits them) and must NOT
 * carry the app-wide frame-ancestors/X-Frame-Options lockdown — the scheme
 * exists to be framed; setup-security exempts it from the global stamp.
 */
describe('MCP App shell protocol', () => {
  it('serves a registered shell with header-delivered policies and hardened metadata', async () => {
    const registry = new McpAppShellRegistry();
    const lease = registry.register(7, SHELL);
    expect(lease.shellUrl).toBe(`${MCP_APP_SHELL_PROTOCOL_SCHEME}://${lease.token}/`);
    expect(lease.token).toMatch(/^[0-9a-f]{32}$/u);

    const handler = createMcpAppShellProtocolHandler(registry);
    const response = await handler(new Request(lease.shellUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(SHELL.contentSecurityPolicy);
    expect(response.headers.get('Permissions-Policy')).toBe(SHELL.permissionsPolicy);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).not.toContain('frame-ancestors');
    await expect(response.text()).resolves.toBe(SHELL.document);
  });

  it('returns 404 immediately after release and for unknown or malformed tokens', async () => {
    const registry = new McpAppShellRegistry();
    const lease = registry.register(7, SHELL);
    const handler = createMcpAppShellProtocolHandler(registry);

    expect(registry.release(7, lease.token)).toBe(true);
    expect(registry.release(7, lease.token)).toBe(false);
    expect(registry.size).toBe(0);
    for (const url of [
      lease.shellUrl,
      mcpAppShellUrl('0'.repeat(32)),
      `${MCP_APP_SHELL_PROTOCOL_SCHEME}://not-a-token/`,
      `${MCP_APP_SHELL_PROTOCOL_SCHEME}://${lease.token}/extra`,
      `${MCP_APP_SHELL_PROTOCOL_SCHEME}://${lease.token}/../escape`,
    ]) {
      const response = await handler(new Request(url));
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe('Not found');
    }
  });

  it('rejects every method but GET with 405', async () => {
    const registry = new McpAppShellRegistry();
    const lease = registry.register(7, SHELL);
    const handler = createMcpAppShellProtocolHandler(registry);
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      const response = await handler(new Request(lease.shellUrl, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
    expect(registry.resolve(lease.token)).toEqual(SHELL);
  });

  it('fences shells to their registering owner and drops them all when the owner goes away', () => {
    const registry = new McpAppShellRegistry();
    const first = registry.register(1, SHELL);
    const second = registry.register(1, SHELL);
    const other = registry.register(2, SHELL);
    expect(first.token).not.toBe(second.token);

    // Another WebContents can neither release nor learn about an owner's shells.
    expect(registry.release(2, first.token)).toBe(false);
    expect(registry.resolve(first.token)).toBeDefined();

    expect(registry.releaseOwner(1)).toBe(2);
    expect(registry.resolve(first.token)).toBeUndefined();
    expect(registry.resolve(second.token)).toBeUndefined();
    expect(registry.resolve(other.token)).toBeDefined();
    expect(registry.releaseOwner(1)).toBe(0);
    expect(registry.size).toBe(1);
  });

  it('fails closed on per-owner and document-size limits', () => {
    const registry = new McpAppShellRegistry({ maxDocumentBytes: 64, maxShellsPerOwner: 1 });
    registry.register(1, SHELL);
    expect(() => registry.register(1, SHELL)).toThrow(/per-owner limit/);
    expect(() => registry.register(2, { ...SHELL, document: 'x'.repeat(65) })).toThrow(
      /byte limit/
    );
    expect(registry.size).toBe(1);
    expect(() => new McpAppShellRegistry({ maxShellsPerOwner: 0 })).toThrow(TypeError);
  });
});
