import { expect, it, vi } from 'vitest';

vi.mock('@brainstrike/db', () => {
  throw new Error('Desktop production MCP composition must not load PGlite');
});

it('composes production MCP capabilities without loading the conformance database owner', async () => {
  const { createDesktopMcpPlatformCapabilities } = await import('../mcp/desktop-host-platform');
  const { MainMcpHostControl } = await import('../mcp/main-host-control');
  const control = new MainMcpHostControl();
  const platform = createDesktopMcpPlatformCapabilities(control);
  expect(platform.control).toBe(control);
  expect(platform.openExternal).toBeTypeOf('function');
});
