// @vitest-environment node
/**
 * BST-1178: the agent reaches a loopback server only at the exact
 * `localhost`, `127.0.0.1` or `[::1]` origin its navigation opens, which a
 * person approved; Main admits that `host:port` in the egress proxy and
 * replaces it at the next navigation.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEgressHost, type EgressUtility } from '../browser/agent-egress/agent-egress-host';
import { type EgressProxy, startEgressProxy } from '../browser/agent-egress/egress-proxy';
import { agentNavigationTarget } from '../browser/browser-url';

describe('agentNavigationTarget', () => {
  it.each([
    ['http://localhost:5173/app', 'localhost:5173', 'http://localhost:5173'],
    ['localhost:3000', 'localhost:3000', 'https://localhost:3000'],
    ['https://localhost/', 'localhost:443', 'https://localhost'],
    ['http://127.0.0.1:8080/x', '127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:4000', '::1:4000', 'http://[::1]:4000'],
    ['http://127.0.0.1', '127.0.0.1:80', 'http://127.0.0.1'],
  ])('admits the loopback server %s at its exact port', (url, loopback, origin) => {
    expect(agentNavigationTarget(url)).toMatchObject({ loopback, origin });
  });

  it('names no loopback server for a public page', () => {
    expect(agentNavigationTarget('https://example.com/a')).toEqual({
      origin: 'https://example.com',
      url: 'https://example.com/a',
    });
  });

  it.each([
    'http://127.0.0.2:3000',
    'http://10.0.0.5:3000',
    'http://192.168.1.2',
    'http://169.254.169.254/latest/meta-data',
    'http://app.localhost:3000',
    'http://[::ffff:7f00:1]:3000',
    'file:///etc/passwd',
  ])('still refuses %s', (url) => {
    expect(agentNavigationTarget(url)).toHaveProperty('refusal');
  });

  it('refuses a loopback URL that carries credentials', () => {
    expect(agentNavigationTarget('http://user:secret@localhost:5173')).toEqual({
      refusal: 'refused: URLs with embedded credentials are never opened by the agent',
    });
  });
});

const CREDENTIAL = 'agent:loopback-test';
const servers: Server[] = [];
const proxies: EgressProxy[] = [];
afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function loopbackServer(): Promise<number> {
  const server = createServer((socket) => socket.end('dev server'));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not bind');
  }
  return address.port;
}

/** The status line the proxy answers a CONNECT with. */
async function connectThrough(proxy: EgressProxy, authority: string): Promise<string> {
  const socket: Socket = connect({ host: '127.0.0.1', port: proxy.port });
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.once('connect', () => {
        const basic = Buffer.from(CREDENTIAL).toString('base64');
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`
        );
      });
      socket.once('data', (chunk) => resolve(chunk.toString('latin1').split('\r\n')[0] ?? ''));
      socket.once('error', reject);
    });
  } finally {
    socket.destroy();
  }
}

describe('egress proxy loopback admission', () => {
  it('dials an admitted loopback server at its literal, never through DNS', async () => {
    const port = await loopbackServer();
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const proxy = await startEgressProxy({ credential: CREDENTIAL, resolve });
    proxies.push(proxy);

    await expect(connectThrough(proxy, `localhost:${port}`)).resolves.toBe('HTTP/1.1 403 Refused');
    proxy.admitLoopback([`localhost:${port}`]);
    const resolvedBefore = resolve.mock.calls.length;
    await expect(connectThrough(proxy, `localhost:${port}`)).resolves.toBe(
      'HTTP/1.1 200 Connection Established'
    );
    // The admitted CONNECT never asked the resolver.
    expect(resolve.mock.calls).toHaveLength(resolvedBefore);
    // Only the admitted host and port: another spelling or port stays refused.
    await expect(connectThrough(proxy, `127.0.0.1:${port}`)).resolves.toBe('HTTP/1.1 403 Refused');
    await expect(connectThrough(proxy, `localhost:${port + 1}`)).resolves.toBe(
      'HTTP/1.1 403 Refused'
    );
    // The next navigation's set replaces it.
    proxy.admitLoopback([]);
    await expect(connectThrough(proxy, `localhost:${port}`)).resolves.toBe('HTTP/1.1 403 Refused');
  });

  it.each([
    'example.com:80',
    '10.0.0.5:3000',
    '127.0.0.2:3000',
    'localhost:0',
    'localhost:70000',
    'localhost',
  ])('refuses to admit %s', async (authority) => {
    const proxy = await startEgressProxy({ credential: CREDENTIAL });
    proxies.push(proxy);
    expect(() => proxy.admitLoopback([authority])).toThrow('Not an admissible loopback server');
  });
});

/** A fake egress utility that answers its start and each loopback revision as told. */
function fakeUtility(answer: 'admit' | 'refuse' | 'silent' | 'exit') {
  const listeners: ((message: unknown) => void)[] = [];
  let exited: ((code: number) => void) | undefined;
  const posted: unknown[] = [];
  const utility: EgressUtility = {
    kill: () => {
      exited?.(0);
      return true;
    },
    on: (_event, listener) => {
      listeners.push(listener);
    },
    once: (_event, listener) => {
      exited = listener;
    },
    postMessage: (message) => {
      posted.push(message);
      const command = message as { revision?: number; type: string };
      queueMicrotask(() => {
        const emit = (event: unknown): void => {
          for (const listener of listeners) {
            listener(event);
          }
        };
        if (command.type === 'start') {
          emit({ port: 4321, type: 'ready' });
        } else if (answer === 'admit') {
          emit({ revision: command.revision, type: 'loopback-admitted' });
        } else if (answer === 'refuse') {
          emit({ message: 'no', revision: command.revision, type: 'loopback-refused' });
        } else if (answer === 'exit') {
          exited?.(1);
        }
      });
    },
  };
  return { posted, utility };
}

describe('AgentEgressHost.admitLoopback', () => {
  it('resolves once the proxy admits that revision', async () => {
    const { posted, utility } = fakeUtility('admit');
    const host = new AgentEgressHost(() => utility);
    await host.admitLoopback(['localhost:5173']);
    await host.admitLoopback([]);
    expect(posted).toEqual([
      expect.objectContaining({ type: 'start' }),
      { authorities: ['localhost:5173'], revision: 1, type: 'loopback' },
      { authorities: [], revision: 2, type: 'loopback' },
    ]);
  });

  it('rejects when the proxy refuses, exits or stays silent, so no navigation starts', async () => {
    await expect(
      new AgentEgressHost(() => fakeUtility('refuse').utility).admitLoopback(['localhost:1'])
    ).rejects.toThrow('The agent browsing proxy refused loopback: no');
    await expect(
      new AgentEgressHost(() => fakeUtility('exit').utility).admitLoopback(['localhost:1'])
    ).rejects.toThrow('exited before it admitted loopback');
    vi.useFakeTimers();
    try {
      const silent = new AgentEgressHost(() => fakeUtility('silent').utility).admitLoopback([
        'localhost:1',
      ]);
      const settled = expect(silent).rejects.toThrow('did not admit loopback servers in time');
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
