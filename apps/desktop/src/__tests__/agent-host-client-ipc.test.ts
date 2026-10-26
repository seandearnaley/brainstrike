import type { HostClient } from '@brainstrike/agent-host/client';
import { describe, expect, it, vi } from 'vitest';

type ConnectHandler = (event: unknown, requestId: unknown) => Promise<{ readonly ok: boolean }>;

const registered = vi.hoisted(() => ({ connect: undefined as ConnectHandler | undefined }));

vi.mock('../platform/desktop-ipc-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/desktop-ipc-registry')>();
  return {
    ...actual,
    createDesktopIpcRegistry: () => ({
      registerAuthorizedInvoke: (
        _domain: string,
        _channel: string,
        _policy: unknown,
        handler: ConnectHandler
      ) => {
        registered.connect = handler;
      },
      unregisterAll: () => undefined,
    }),
  };
});

const { registerAgentHostClientIpc } = await import('../agent-host-client-ipc');

describe('registerAgentHostClientIpc', () => {
  it('quits without waiting for a connect whose host never becomes available', async () => {
    const openPrivateClientPort = vi.fn(() => undefined);
    const bridge = registerAgentHostClientIpc(
      () => new Promise<HostClient>(() => undefined),
      openPrivateClientPort
    );
    const postMessage = vi.fn();
    const connect = registered.connect;
    if (!connect) {
      throw new Error('The agent host connect channel was not registered');
    }

    const connected = connect(
      {
        sender: { isDestroyed: () => false, off: vi.fn(), once: vi.fn() },
        senderFrame: { postMessage },
      },
      crypto.randomUUID()
    );

    await bridge.close();

    await expect(connected).resolves.toMatchObject({ ok: false });
    expect(postMessage).not.toHaveBeenCalled();
    expect(openPrivateClientPort).not.toHaveBeenCalled();
  });
});
