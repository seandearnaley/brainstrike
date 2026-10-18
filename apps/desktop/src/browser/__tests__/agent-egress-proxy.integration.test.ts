// The agent browser's egress proxy (BST-1238) over real loopback sockets. A fake
// resolver plays DNS, and the dial seam lands every checked "public" address on
// a local server, recording the address the proxy chose to connect to.
import { once } from 'node:events';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import {
  EGRESS_REFUSAL_HEADER,
  type EgressProxy,
  type EgressRefusal,
  type ResolvedAddress,
  startEgressProxy,
} from '../agent-egress/egress-proxy';

const CREDENTIAL = 'agent:per-launch-secret';
const AUTHORIZATION = `Basic ${Buffer.from(CREDENTIAL).toString('base64')}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A TCP echo server that stands in for every admitted destination. */
async function echoServer(): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.pipe(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => {
    server.close();
  });
  return (server.address() as { port: number }).port;
}

async function httpServer(): Promise<{ port: number; seen: Record<string, unknown>[] }> {
  const seen: Record<string, unknown>[] = [];
  const server: Server = createHttpServer((request, response) => {
    seen.push({ headers: request.headers, method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('public page');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, seen };
}

interface Harness {
  readonly dialed: string[];
  readonly proxy: EgressProxy;
  readonly refusals: EgressRefusal[];
  readonly resolved: string[];
}

async function startProxy(
  answers: (
    host: string,
    call: number
  ) => readonly ResolvedAddress[] | Promise<readonly ResolvedAddress[]>,
  landingPort: number,
  connectTimeoutMs?: number
): Promise<Harness> {
  const dialed: string[] = [];
  const resolved: string[] = [];
  const refusals: EgressRefusal[] = [];
  const proxy = await startEgressProxy({
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    credential: CREDENTIAL,
    dial: (address, port) => {
      dialed.push(`${address}:${port}`);
      return connect({ host: '127.0.0.1', port: landingPort });
    },
    onRefusal: (refusal) => refusals.push(refusal),
    resolve: async (host) => {
      resolved.push(host);
      return answers(host, resolved.length);
    },
  });
  cleanups.push(() => proxy.close());
  return { dialed, proxy, refusals, resolved };
}

const publicAnswer = (): readonly ResolvedAddress[] => [{ address: '93.184.216.34', family: 4 }];

interface ConnectReply {
  readonly headers: Record<string, string>;
  readonly socket: Socket;
  readonly status: number;
}

/** Send `CONNECT authority` and read the proxy's reply head. */
async function connectThrough(
  port: number,
  authority: string,
  authorization: string | null = AUTHORIZATION
): Promise<ConnectReply> {
  const socket = connect({ host: '127.0.0.1', port });
  cleanups.push(() => {
    socket.destroy();
  });
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
      authorization === null ? '' : `Proxy-Authorization: ${authorization}\r\n`
    }\r\n`
  );
  let buffered = '';
  while (!buffered.includes('\r\n\r\n')) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    buffered += chunk.toString('latin1');
  }
  const [head = ''] = buffered.split('\r\n\r\n');
  const [statusLine = '', ...lines] = head.split('\r\n');
  const headers = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    })
  );
  return { headers, socket, status: Number(statusLine.split(' ')[1]) };
}

async function echo(socket: Socket, text: string): Promise<string> {
  socket.write(text);
  const [chunk] = (await once(socket, 'data')) as [Buffer];
  return chunk.toString('utf8');
}

interface ForwardReply {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly status: number;
}

/** Send an absolute-form http request through the proxy. */
async function forwardThrough(
  port: number,
  url: string,
  authorization: string | null = AUTHORIZATION
): Promise<ForwardReply> {
  const request = httpRequest({
    headers: {
      host: new URL(url).host,
      ...(authorization === null ? {} : { 'proxy-authorization': authorization }),
    },
    host: '127.0.0.1',
    path: url,
    port,
  });
  request.end();
  const [response] = (await once(request, 'response')) as [import('node:http').IncomingMessage];
  let body = '';
  for await (const chunk of response) {
    body += String(chunk);
  }
  return { body, headers: response.headers, status: response.statusCode ?? 0 };
}

test('a tunnel to a public answer connects to the checked address, never the hostname', async () => {
  const { proxy, dialed, resolved } = await startProxy(publicAnswer, await echoServer());
  const reply = await connectThrough(proxy.port, 'public.test:443');
  expect(reply.status).toBe(200);
  expect(await echo(reply.socket, 'hello')).toBe('hello');
  expect(resolved).toEqual(['public.test']);
  expect(dialed).toEqual(['93.184.216.34:443']);
});

test.each([
  ['127.0.0.1', 'loopback'],
  ['10.0.0.7', 'private'],
  ['169.254.169.254', 'link-local'],
  ['::1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['64:ff9b::a9fe:a9fe', 'link-local'],
  ['fd00:ec2::254', 'private'],
])(
  'a hostname that resolves to %s is refused as %s before any connection',
  async (address, addressClass) => {
    const { proxy, dialed, refusals } = await startProxy(
      () => [{ address, family: address.includes(':') ? 6 : 4 }],
      await echoServer()
    );
    const reply = await connectThrough(proxy.port, 'rebound.test:443');
    expect(reply.status).toBe(403);
    expect(reply.headers[EGRESS_REFUSAL_HEADER]).toBe(addressClass);
    expect(dialed).toEqual([]);
    expect(refusals).toEqual([
      { address, addressClass, host: 'rebound.test', reason: 'destination' },
    ]);
  }
);

test('one blocked answer among public ones refuses the whole destination', async () => {
  const { proxy, dialed } = await startProxy(
    () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ],
    await echoServer()
  );
  const reply = await connectThrough(proxy.port, 'mixed.test:443');
  expect(reply.status).toBe(403);
  expect(reply.headers[EGRESS_REFUSAL_HEADER]).toBe('private');
  expect(dialed).toEqual([]);
});

test.each([
  ['127.0.0.1:443', 'loopback'],
  ['[::1]:443', 'loopback'],
  ['[::ffff:7f00:1]:80', 'loopback'],
  ['169.254.169.254:80', 'link-local'],
  ['[64:ff9b::7f00:1]:80', 'loopback'],
  ['[2002:7f00:1::]:443', 'ipv4-carrier'],
])('a literal %s target is refused as %s without resolving', async (authority, addressClass) => {
  const { proxy, dialed, resolved } = await startProxy(publicAnswer, await echoServer());
  const reply = await connectThrough(proxy.port, authority);
  expect(reply.status).toBe(403);
  expect(reply.headers[EGRESS_REFUSAL_HEADER]).toBe(addressClass);
  expect(resolved).toEqual([]);
  expect(dialed).toEqual([]);
});

test('DNS rebinding cannot move an admitted connection: each connection is checked and pinned once', async () => {
  // The resolver answers public, then loopback, as a rebinding attacker would.
  const { proxy, dialed, resolved } = await startProxy(
    (_host, call) => (call === 1 ? publicAnswer() : [{ address: '127.0.0.1', family: 4 }]),
    await echoServer()
  );
  const first = await connectThrough(proxy.port, 'rebinding.test:443');
  expect(first.status).toBe(200);
  expect(await echo(first.socket, 'still public')).toBe('still public');
  const second = await connectThrough(proxy.port, 'rebinding.test:443');
  expect(second.status).toBe(403);
  expect(second.headers[EGRESS_REFUSAL_HEADER]).toBe('loopback');
  // One resolution per connection, and only the checked public address dialed.
  expect(resolved).toEqual(['rebinding.test', 'rebinding.test']);
  expect(dialed).toEqual(['93.184.216.34:443']);
});

test('an unresolvable host and a malformed authority are refused visibly', async () => {
  const { proxy, dialed } = await startProxy(() => [], await echoServer());
  const unresolved = await connectThrough(proxy.port, 'nowhere.test:443');
  expect(unresolved.status).toBe(403);
  expect(unresolved.headers[EGRESS_REFUSAL_HEADER]).toBe('unresolved');
  const malformed = await connectThrough(proxy.port, 'no-port.test');
  expect(malformed.status).toBe(400);
  expect(malformed.headers[EGRESS_REFUSAL_HEADER]).toBe('malformed');
  expect(dialed).toEqual([]);
});

test.each([
  ['no credential', null],
  ['a wrong credential', `Basic ${Buffer.from('agent:guess').toString('base64')}`],
  ['a non-Basic scheme', 'Bearer per-launch-secret'],
])('a tunnel with %s is challenged and never resolved', async (_label, authorization) => {
  const { proxy, dialed, resolved } = await startProxy(publicAnswer, await echoServer());
  const reply = await connectThrough(proxy.port, 'public.test:443', authorization);
  expect(reply.status).toBe(407);
  expect(reply.headers['proxy-authenticate']).toMatch(/^Basic /);
  expect(resolved).toEqual([]);
  expect(dialed).toEqual([]);
});

test('a plain http request is forwarded to the checked address with its Host and without the proxy credential', async () => {
  const site = await httpServer();
  const { proxy, dialed } = await startProxy(publicAnswer, site.port);
  const reply = await forwardThrough(proxy.port, 'http://public.test:8080/page?q=1');
  expect(reply.status).toBe(200);
  expect(reply.body).toBe('public page');
  expect(dialed).toEqual(['93.184.216.34:8080']);
  expect(site.seen).toHaveLength(1);
  const [seen] = site.seen as [{ headers: Record<string, string>; method: string; url: string }];
  expect(seen.method).toBe('GET');
  expect(seen.url).toBe('/page?q=1');
  expect(seen.headers['host']).toBe('public.test:8080');
  expect(seen.headers['proxy-authorization']).toBeUndefined();
});

test('a plain http request to a private destination or without a credential is refused', async () => {
  const site = await httpServer();
  const { proxy, dialed } = await startProxy(
    (host) => (host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : publicAnswer()),
    site.port
  );
  const loopback = await forwardThrough(proxy.port, 'http://localhost:3000/');
  expect(loopback.status).toBe(403);
  expect(loopback.headers[EGRESS_REFUSAL_HEADER]).toBe('loopback');
  const metadata = await forwardThrough(proxy.port, 'http://169.254.169.254/latest/meta-data/');
  expect(metadata.status).toBe(403);
  expect(metadata.headers[EGRESS_REFUSAL_HEADER]).toBe('link-local');
  const unauthenticated = await forwardThrough(proxy.port, 'http://public.test/', null);
  expect(unauthenticated.status).toBe(407);
  expect(dialed).toEqual([]);
  expect(site.seen).toEqual([]);
});

test('closing the proxy ends its open tunnels', async () => {
  const { proxy } = await startProxy(publicAnswer, await echoServer());
  const reply = await connectThrough(proxy.port, 'public.test:443');
  expect(reply.status).toBe(200);
  const ended = once(reply.socket, 'close');
  await proxy.close();
  await ended;
});

test('closing the proxy while a host is still resolving never dials it afterwards', async () => {
  const asked = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<readonly ResolvedAddress[]>();
  const { proxy, dialed } = await startProxy(
    () => {
      asked.resolve();
      return answer.promise;
    },
    await echoServer()
  );
  const socket = connect({ host: '127.0.0.1', port: proxy.port });
  cleanups.push(() => {
    socket.destroy();
  });
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  const ended = once(socket, 'close');
  socket.write(
    `CONNECT slow.test:443 HTTP/1.1\r\nHost: slow.test:443\r\nProxy-Authorization: ${AUTHORIZATION}\r\n\r\n`
  );
  await asked.promise;
  await proxy.close();
  // The resolver answers only after close; nothing may connect on its answer.
  answer.resolve(publicAnswer());
  await ended;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(dialed).toEqual([]);
});

test('a resolver that never answers fails the admission at its deadline', async () => {
  const { proxy, dialed } = await startProxy(
    () => new Promise<readonly ResolvedAddress[]>(() => undefined),
    await echoServer(),
    100
  );
  const startedAt = Date.now();
  const reply = await connectThrough(proxy.port, 'stalled.test:443');
  expect(reply.status).toBe(502);
  expect(Date.now() - startedAt).toBeLessThan(5000);
  expect(dialed).toEqual([]);
});
