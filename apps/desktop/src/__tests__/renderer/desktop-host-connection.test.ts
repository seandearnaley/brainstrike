import type { HostClient } from '@brainstrike/agent-host/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopHostConnection } from '../../renderer/desktop-host-connection';

// The window's real connector loads the browser JSON-RPC transport; each test injects its own.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

/** A client whose transport the test ends, as Main's relay does when the host is lost. */
function liveClient() {
  const closed = Promise.withResolvers<void>();
  const client = {
    close: vi.fn(async () => closed.resolve()),
    closed: closed.promise,
  } as unknown as HostClient;
  return { client, lose: () => closed.resolve() };
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
});

describe('desktop host connection (BST-2004)', () => {
  it('makes one automatic attempt when its client closes, and the next generation replaces it', async () => {
    const first = liveClient();
    const second = liveClient();
    const connect = vi
      .fn<() => Promise<HostClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const connection = createDesktopHostConnection(connect);
    expect(await connection.current()).toBe(first.client);
    const replaced = connection.replacement(first.client);
    first.lose();
    expect(await replaced).toBe(second.client);
    expect(connection.getSnapshot()).toMatchObject({ client: second.client, generation: 2 });
    expect(await connection.current()).toBe(second.client);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('stays failed after a second loss until the user reconnects (crash loop)', async () => {
    const clients = [liveClient(), liveClient(), liveClient()];
    const connect = vi.fn<() => Promise<HostClient>>();
    for (const { client } of clients) {
      connect.mockResolvedValueOnce(client);
    }
    const connection = createDesktopHostConnection(connect);
    await connection.current();
    clients[0]?.lose();
    await vi.waitFor(() => expect(connection.getSnapshot().kind).toBe('connected'));
    clients[1]?.lose();
    await settle();
    expect(connection.getSnapshot()).toMatchObject({ kind: 'failed' });
    expect(connect).toHaveBeenCalledTimes(2);
    await expect(connection.current()).rejects.toThrow('stopped again');

    // A send waiting on the lost host resolves on the client the user's Reconnect brings.
    const replaced = connection.replacement(clients[1]?.client as HostClient);
    connection.reconnect();
    expect(await replaced).toBe(clients[2]?.client);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('reports a failed attempt and lets the user try again', async () => {
    const first = liveClient();
    const second = liveClient();
    const connect = vi
      .fn<() => Promise<HostClient>>()
      .mockResolvedValueOnce(first.client)
      .mockRejectedValueOnce(new Error('Agent client disconnected before attach'))
      .mockResolvedValueOnce(second.client);
    const connection = createDesktopHostConnection(connect);
    await connection.current();
    first.lose();
    await vi.waitFor(() =>
      expect(connection.getSnapshot()).toEqual({
        error: 'Agent client disconnected before attach',
        kind: 'failed',
      })
    );
    connection.reconnect();
    expect(await connection.replacement(first.client)).toBe(second.client);
  });

  it('never reconnects a client the frame closed, and refuses work once closed', async () => {
    const first = liveClient();
    const connect = vi.fn<() => Promise<HostClient>>().mockResolvedValueOnce(first.client);
    const connection = createDesktopHostConnection(connect);
    await connection.current();
    const waiting = connection.replacement(first.client);
    window.dispatchEvent(new Event('beforeunload'));
    await expect(waiting).rejects.toThrow('closing');
    // The frame's close joins the client's own close.
    await connection.close();
    expect(first.client.close).toHaveBeenCalledOnce();
    await settle();
    expect(connect).toHaveBeenCalledOnce();
    expect(connection.getSnapshot()).toEqual({ kind: 'closed' });
    await expect(connection.current()).rejects.toThrow('closing');
  });
});
