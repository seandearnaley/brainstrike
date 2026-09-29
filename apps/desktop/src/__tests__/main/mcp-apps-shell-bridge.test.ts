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

  constructor(readonly id: number) {}

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
  const registerAuthorizedInvoke = vi.fn(
    (_domain: string, channel: string, _policy: unknown, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }
  );
  attachMcpAppShellBridge(registry, {
    registerAuthorizedInvoke: registerAuthorizedInvoke as never,
  });
  const invoke = (channel: string, sender: FakeSender, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler for ${channel}`);
    }
    return handler({ sender }, ...args);
  };
  return { invoke, registerAuthorizedInvoke, registry };
}

describe('attachMcpAppShellBridge', () => {
  it('registers the two visible-UI shell channels', () => {
    const { registerAuthorizedInvoke } = attach();
    expect(registerAuthorizedInvoke.mock.calls.map((call) => call[1])).toEqual([
      'mcp:apps:prepareShell',
      'mcp:apps:releaseShell',
    ]);
    for (const call of registerAuthorizedInvoke.mock.calls) {
      expect(call[2]).toEqual({ roles: ['visible-ui'] });
    }
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
    ).rejects.toThrow(/not registered to this sender/);
    expect(registry.resolve(lease.token)).toBeDefined();

    await invoke('mcp:apps:releaseShell', sender, { token: lease.token });
    expect(registry.resolve(lease.token)).toBeUndefined();
    await expect(invoke('mcp:apps:releaseShell', sender, { token: lease.token })).rejects.toThrow(
      /not registered to this sender/
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
      /exactly 1 argument/
    );
    await expect(
      invoke('mcp:apps:releaseShell', sender, { token: '0'.repeat(32) }, 'extra')
    ).rejects.toThrow(/exactly 1 argument/);
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
      /destroyed WebContents/
    );
    expect(registry.size).toBe(1);
  });
});
