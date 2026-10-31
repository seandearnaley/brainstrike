import { describe, expect, it, vi } from 'vitest';
import type { HostClientOrigin, HostWorkspaceDiscovery } from '../src/ports.js';
import type { HostMethod } from '../src/protocol.js';
import { bindHostWorkspaceDiscoveryMethods } from '../src/workspace-discovery-connection.js';

function bound(discovery: HostWorkspaceDiscovery, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, () => Promise<unknown>>();
  bindHostWorkspaceDiscoveryMethods(
    (method, request) => {
      handlers.set(method, async () => await request({} as never, new AbortController().signal));
    },
    discovery,
    origin
  );
  return handlers;
}

function discovery(): HostWorkspaceDiscovery {
  return {
    commands: vi.fn(async () => ({ commands: [], roots: [] })),
    contextFiles: vi.fn(async () => ({ files: [] })),
    personas: vi.fn(async () => ({ personas: [] })),
    skills: vi.fn(async () => ({ entries: [] })),
    trust: vi.fn(async () => ({ roots: [] })),
  };
}

/** ADR-0029 stage 2a: Settings' persona checks and instructions files are the desktop user's. */
describe('host workspace discovery methods', () => {
  it("answers the desktop's private client with personas and instructions files", async () => {
    const service = discovery();
    const handlers = bound(service, 'desktop-ui');

    await expect(handlers.get('workspace/personas')?.()).resolves.toEqual({ personas: [] });
    await expect(handlers.get('workspace/context-files')?.()).resolves.toEqual({ files: [] });
  });

  it('refuses personas and instructions files to a public-socket client, never scanning', async () => {
    const service = discovery();
    const handlers = bound(service, 'public-socket');

    for (const method of ['workspace/personas', 'workspace/context-files'] as const) {
      await expect(handlers.get(method)?.()).rejects.toThrow(
        "Personas and workspace instructions files are available only to the desktop's private client"
      );
    }
    expect(service.personas).not.toHaveBeenCalled();
    expect(service.contextFiles).not.toHaveBeenCalled();
    // Skills and commands stay readable to a CLI attached over the socket.
    await expect(handlers.get('workspace/skills')?.()).resolves.toEqual({ entries: [] });
  });
});
