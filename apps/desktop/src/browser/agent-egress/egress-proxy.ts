/**
 * The agent browser partition's only route to the network (BST-1238).
 *
 * Chromium sends every agent-tab connection here: `CONNECT host:port` for
 * https and WebSockets, and absolute-form requests for plain http. The proxy
 * resolves the host itself, refuses the connection when ANY answer is an
 * address agent browsing may not reach ({@link refusedAddressClass}), and then
 * dials the checked address, never the hostname. A DNS answer that changes
 * after the check (rebinding) therefore cannot change the connection target,
 * and redirects, client navigations, popups and subresources are each checked
 * as the connections they open.
 *
 * It listens on loopback and requires a per-launch credential, so no other
 * local process can borrow it as a relay.
 */
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { type RefusedAddressClass, refusedAddressClass } from './address-policy';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type EgressRefusal =
  | {
      readonly reason: 'destination';
      readonly host: string;
      readonly address: string;
      readonly addressClass: RefusedAddressClass;
    }
  | { readonly reason: 'unresolved'; readonly host: string }
  | { readonly reason: 'malformed'; readonly target: string };

export interface EgressProxyOptions {
  /** How long resolution plus the TCP connect may take. Default 15 s. */
  readonly connectTimeoutMs?: number;
  /** The `user:password` Chromium must present as Basic proxy credentials. */
  readonly credential: string;
  /** Open a TCP connection to a checked address. Tests redirect it. */
  readonly dial?: (address: string, port: number) => Socket;
  /** Told about every refused connection, for the tab's visible failure. */
  readonly onRefusal?: (refusal: EgressRefusal) => void;
  /** Resolve every address of a hostname. Defaults to the system resolver. */
  readonly resolve?: (host: string) => Promise<readonly ResolvedAddress[]>;
}

export interface EgressProxy {
  close(): Promise<void>;
  readonly port: number;
}

export const EGRESS_REFUSAL_HEADER = 'x-brainstrike-egress-refusal';
const REALM = 'Basic realm="brainstrike-agent-browser"';

async function systemResolve(host: string): Promise<readonly ResolvedAddress[]> {
  const answers = await lookup(host, { all: true, order: 'verbatim' });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

function defaultDial(address: string, port: number): Socket {
  return connect({ host: address, port });
}

/** `host:port`, with a bracketed IPv6 host. Null when it is not one. */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = authority.match(/^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!(host && Number.isInteger(port)) || port < 1 || port > 65_535) {
    return null;
  }
  return { host: host.toLowerCase(), port };
}

function credentialMatches(headers: IncomingHttpHeaders, expected: Buffer): boolean {
  const header = headers['proxy-authorization'];
  const match = typeof header === 'string' ? header.match(/^Basic\s+(\S+)$/i) : null;
  if (!match?.[1]) {
    return false;
  }
  const presented = Buffer.from(match[1], 'base64');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

class Refused extends Error {
  readonly refusal: EgressRefusal;
  constructor(refusal: EgressRefusal) {
    super(`Agent browsing refused ${refusal.reason}`);
    this.refusal = refusal;
  }
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const expected = Buffer.from(options.credential, 'utf8');
  const resolve = options.resolve ?? systemResolve;
  const dial = options.dial ?? defaultDial;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const open = new Set<Duplex>();
  const track = (stream: Duplex): void => {
    open.add(stream);
    stream.once('close', () => open.delete(stream));
  };

  const refuse = (refusal: EgressRefusal): never => {
    options.onRefusal?.(refusal);
    throw new Refused(refusal);
  };

  /** Every answer for `host`, refused unless all of them may be reached. */
  const checkedAnswers = async (host: string): Promise<readonly ResolvedAddress[]> => {
    const family = isIP(host);
    const answers =
      family === 0
        ? await resolve(host).catch((): readonly ResolvedAddress[] => [])
        : [{ address: host, family: family === 6 ? (6 as const) : (4 as const) }];
    if (answers.length === 0) {
      refuse({ host, reason: 'unresolved' });
    }
    for (const { address } of answers) {
      const addressClass = refusedAddressClass(address);
      if (addressClass) {
        refuse({ address, addressClass, host, reason: 'destination' });
      }
    }
    return answers;
  };

  const dialChecked = (address: string, port: number): Promise<Socket> =>
    new Promise<Socket>((resolveSocket, reject) => {
      const socket = dial(address, port);
      track(socket);
      socket.setTimeout(connectTimeoutMs, () =>
        socket.destroy(new Error('Agent browsing connect timed out'))
      );
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', reject);
        resolveSocket(socket);
      });
      socket.once('error', reject);
    });

  /** Resolve once, check every answer, and connect to the first checked address that accepts. */
  const admit = async (host: string, port: number): Promise<Socket> => {
    const answers = await checkedAnswers(host);
    let lastFailure: unknown;
    for (const { address } of answers) {
      try {
        return await dialChecked(address, port);
      } catch (failure) {
        lastFailure = failure;
      }
    }
    throw lastFailure;
  };

  const statusFor = (failure: unknown): { status: number; refusal?: string } => {
    if (failure instanceof Refused) {
      const { refusal } = failure;
      return {
        refusal: refusal.reason === 'destination' ? refusal.addressClass : refusal.reason,
        status: refusal.reason === 'malformed' ? 400 : 403,
      };
    }
    return { status: 502 };
  };

  const server = createServer();

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const reply = (status: number, headers: Record<string, string> = {}): void => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
      client.end(
        `HTTP/1.1 ${status} ${status === 407 ? 'Proxy Authentication Required' : 'Refused'}\r\n${lines.join('')}Content-Length: 0\r\n\r\n`
      );
    };
    if (!credentialMatches(request.headers, expected)) {
      reply(407, { 'Proxy-Authenticate': REALM });
      return;
    }
    const target = parseAuthority(request.url ?? '');
    if (!target) {
      reply(400, { [EGRESS_REFUSAL_HEADER]: 'malformed' });
      options.onRefusal?.({ reason: 'malformed', target: request.url ?? '' });
      return;
    }
    admit(target.host, target.port).then(
      (upstream) => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
      },
      (failure: unknown) => {
        const { refusal, status } = statusFor(failure);
        reply(status, refusal ? { [EGRESS_REFUSAL_HEADER]: refusal } : {});
      }
    );
  });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const fail = (status: number, headers: Record<string, string> = {}): void => {
      if (!response.headersSent) {
        response.writeHead(status, { ...headers, 'content-length': '0' });
      }
      response.end();
    };
    if (!credentialMatches(request.headers, expected)) {
      fail(407, { 'proxy-authenticate': REALM });
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      url = new URL('invalid:');
    }
    if (url.protocol !== 'http:') {
      options.onRefusal?.({ reason: 'malformed', target: request.url ?? '' });
      fail(400, { [EGRESS_REFUSAL_HEADER]: 'malformed' });
      return;
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    const port = url.port === '' ? 80 : Number(url.port);
    admit(host, port).then(
      (upstream) => {
        const headers: IncomingHttpHeaders = Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-'))
        );
        const forwarded = httpRequest(
          {
            createConnection: () => upstream,
            headers,
            method: request.method,
            path: `${url.pathname}${url.search}`,
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.rawHeaders);
            upstreamResponse.pipe(response);
          }
        );
        forwarded.on('error', () => {
          fail(502);
          upstream.destroy();
        });
        response.on('close', () => upstream.destroy());
        request.pipe(forwarded);
      },
      (failure: unknown) => {
        const { refusal, status } = statusFor(failure);
        fail(status, refusal ? { [EGRESS_REFUSAL_HEADER]: refusal } : {});
      }
    );
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The agent browsing proxy did not bind a TCP port');
  }

  return {
    close: async (): Promise<void> => {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const stream of open) {
        stream.destroy();
      }
      server.closeAllConnections();
      await closed;
    },
    port: address.port,
  };
}
