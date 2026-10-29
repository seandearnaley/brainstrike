import { describe, expect, it, vi } from 'vitest';
import { attachMcpAppShellBridge } from '../../mcp/apps-shell-bridge';
import { McpAppShellRegistry } from '../../mcp/apps-shell-protocol';

const SHELL = Object.freeze({
  contentSecurityPolicy: "default-src 'none'",
  document: '<!doctype html><title>shell</title>',
  permissionsPolicy: 'camera=()',
});

type InvokeHandler = (event: { sender: FakeSender }, ...args: unknown[]) => Promise<unknown>;

class FakeSender {
  #destroyed = false;
  readonly #listeners = new Set<() => void>();

  readonly id: number;

  constructor(id: number) {
    this.id = id;
  }

  destroy(): void {
    this.#destroyed = true;
    for (const listener of [...this.#listeners]) {
      this.#listeners.delete(listener);
      listener();
    }
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  once(_event: 'destroyed', listener: () => void): this {
    this.#listeners.add(listener);
    return this;
  }
}

function attach() {
  const registry = new McpAppShellRegistry();
  const handlers = new Map<string, InvokeHandler>();
  const handle = vi.fn((_domain: string, method: string, handler: InvokeHandler) => {
    handlers.set(method, handler);
  });
  attachMcpAppShellBridge(registry, { handle: handle as never });
  const invoke = (method: string, sender: FakeSender, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(method);
    if (handler === undefined) {
      throw new Error(`no handler for ${method}`);
    }
    return handler({ sender }, ...args);
  };
  return { handle, invoke, registry };
}

describe('attachMcpAppShellBridge', () => {
  it('serves the two shell methods in the mcp domain', () => {
    const { handle } = attach();
    expect(handle.mock.calls.map(([domain, method]) => [domain, method])).toEqual([
      ['mcp', 'mcp:apps:prepareShell'],
      ['mcp', 'mcp:apps:releaseShell'],
    ]);
  });

  it('serves a registered shell to its sender and releases it on request', async () => {
    const { invoke, registry } = attach();
    const sender = new FakeSender(4);
    const lease = (await invoke('mcp:apps:prepareShell', sender, SHELL)) as {
      shellUrl: string;
      token: string;
    };
    expect(lease.shellUrl).toBe(`brainstrike-mcp-app://${lease.token}/`);
    expect(registry.resolve(lease.token)).toEqual(SHELL);

    await expect(
      invoke('mcp:apps:releaseShell', new FakeSender(5), { token: lease.token })
    ).rejects.toThrow(/not registered to this sender/u);
    expect(registry.resolve(lease.token)).toBeDefined();

    await invoke('mcp:apps:releaseShell', sender, { token: lease.token });
    expect(registry.resolve(lease.token)).toBeUndefined();
    await expect(invoke('mcp:apps:releaseShell', sender, { token: lease.token })).rejects.toThrow(
      /not registered to this sender/u
    );
  });

  it('rejects malformed requests before touching the registry', async () => {
    const { invoke, registry } = attach();
    const sender = new FakeSender(4);
    await expect(
      invoke('mcp:apps:prepareShell', sender, { ...SHELL, document: '' })
    ).rejects.toThrow();
    await expect(invoke('mcp:apps:releaseShell', sender, { token: 'nope' })).rejects.toThrow();
    await expect(invoke('mcp:apps:prepareShell', sender, SHELL, 'extra')).rejects.toThrow(
      /exactly 1 argument/u
    );
    await expect(
      invoke('mcp:apps:releaseShell', sender, { token: '0'.repeat(32) }, 'extra')
    ).rejects.toThrow(/exactly 1 argument/u);
    expect(registry.size).toBe(0);
  });

  it('drops every shell of a destroyed sender and refuses registrations from one', async () => {
    const { invoke, registry } = attach();
    const sender = new FakeSender(4);
    const other = new FakeSender(9);
    await invoke('mcp:apps:prepareShell', sender, SHELL);
    await invoke('mcp:apps:prepareShell', sender, SHELL);
    const kept = (await invoke('mcp:apps:prepareShell', other, SHELL)) as { token: string };
    expect(registry.size).toBe(3);

    sender.destroy();
    expect(registry.size).toBe(1);
    expect(registry.resolve(kept.token)).toBeDefined();
    await expect(invoke('mcp:apps:prepareShell', sender, SHELL)).rejects.toThrow(
      /destroyed WebContents/u
    );
    expect(registry.size).toBe(1);
  });
});
