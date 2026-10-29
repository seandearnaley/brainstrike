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
 *
 * BST-1178: the one exception is a loopback server a person approved. Main
 * admits that navigation's exact `host:port` ({@link EgressProxy.admitLoopback})
 * before the agent opens it, and replaces it at the next navigation; the
 * proxy dials such a target at its literal, never through DNS.
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

interface ResolvedAddress {
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
  /** One deadline for resolution and every connect attempt. Default 15 s. */
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
  /**
   * The loopback servers agent tabs may reach, replacing the last set: each a
   * `localhost`, `127.0.0.1` or `::1` host at one port (`host:port`).
   */
  admitLoopback(authorities: readonly string[]): void;
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

/** Each admissible loopback host, and the literal addresses it is dialed at. */
const LOOPBACK_ADDRESSES: ReadonlyMap<string, readonly string[]> = new Map([
  ['127.0.0.1', ['127.0.0.1']],
  ['::1', ['::1']],
  ['localhost', ['127.0.0.1', '::1']],
]);

/** A validated set of admitted loopback `host:port` keys. */
function loopbackKeys(authorities: readonly string[]): ReadonlySet<string> {
  return new Set(
    authorities.map((authority) => {
      const separator = authority.lastIndexOf(':');
      const host = authority.slice(0, separator);
      const port = Number(authority.slice(separator + 1));
      if (
        !(LOOPBACK_ADDRESSES.has(host) && Number.isInteger(port) && port >= 1 && port <= 65_535)
      ) {
        throw new Error(`Not an admissible loopback server: ${authority}`);
      }
      return `${host}:${port}`;
    })
  );
}

/** `host:port`, with a bracketed IPv6 host. Null when it is not one. */
function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = authority.match(/^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/u);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!(host && Number.isInteger(port)) || port < 1 || port > 65_535) {
    return null;
  }
  return { host: host.toLowerCase(), port };
}

function credentialMatches(headers: IncomingHttpHeaders, expected: Buffer): boolean {
  const header = headers['proxy-authorization'];
  const match = typeof header === 'string' ? header.match(/^Basic\s+(\S+)$/iu) : null;
  if (!match?.[1]) {
    return false;
  }
  const presented = Buffer.from(match[1], 'base64');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** `work`, or a rejection with the deadline's reason once it fires first. */
function bounded<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolveWork, reject) => {
    const abort = (): void => reject(deadline.reason);
    if (deadline.aborted) {
      abort();
      return;
    }
    deadline.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener('abort', abort);
        resolveWork(value);
      },
      (failure: unknown) => {
        deadline.removeEventListener('abort', abort);
        reject(failure);
      }
    );
  });
}

/** An absolute `http:` URL, the only form a plain-http proxy request takes. */
function absoluteHttpUrl(target: string): URL | null {
  if (!URL.canParse(target)) {
    return null;
  }
  const url = new URL(target);
  return url.protocol === 'http:' ? url : null;
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
  let loopback: ReadonlySet<string> = new Set();
  const track = (stream: Duplex): void => {
    open.add(stream);
    stream.once('close', () => open.delete(stream));
  };
  // Closing aborts every admission still resolving or dialing, and close()
  // joins them, so nothing dials out after the proxy reports itself closed.
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();

  /** Report a refusal and return the error that carries it. */
  const refuse = (refusal: EgressRefusal): Refused => {
    options.onRefusal?.(refusal);
    return new Refused(refusal);
  };

  /** Every answer for `host`, refused unless all of them may be reached. */
  const checkedAnswers = async (
    host: string,
    deadline: AbortSignal
  ): Promise<readonly ResolvedAddress[]> => {
    const family = isIP(host);
    const answers =
      family === 0
        ? await bounded(resolve(host), deadline).catch((failure: unknown) => {
            // A resolver that answers nothing refuses the host; a deadline
            // that fires first is a failed admission, not a refusal.
            if (deadline.aborted) {
              throw failure;
            }
            return [];
          })
        : [{ address: host, family: family === 6 ? (6 as const) : (4 as const) }];
    if (answers.length === 0) {
      throw refuse({ host, reason: 'unresolved' });
    }
    for (const { address } of answers) {
      const addressClass = refusedAddressClass(address);
      if (addressClass !== null) {
        throw refuse({ address, addressClass, host, reason: 'destination' });
      }
    }
    return answers;
  };

  const dialChecked = (address: string, port: number, deadline: AbortSignal): Promise<Socket> =>
    new Promise<Socket>((resolveSocket, reject) => {
      deadline.throwIfAborted();
      const socket = dial(address, port);
      track(socket);
      const abort = (): void => {
        socket.destroy(new Error('Agent browsing admission ended', { cause: deadline.reason }));
      };
      deadline.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => {
        deadline.removeEventListener('abort', abort);
        socket.removeListener('error', reject);
        resolveSocket(socket);
      });
      socket.once('error', (error) => {
        deadline.removeEventListener('abort', abort);
        reject(error);
      });
    });

  /**
   * Resolve once, check every answer, and connect to the first checked address
   * that accepts, all within one deadline that closing the proxy also ends.
   */
  const admit = async (host: string, port: number): Promise<Socket> => {
    const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(connectTimeoutMs)]);
    const answers = loopback.has(`${host}:${port}`)
      ? (LOOPBACK_ADDRESSES.get(host) ?? []).map((address) => ({ address }))
      : await checkedAnswers(host, deadline);
    let lastFailure: unknown;
    for (const { address } of answers) {
      try {
        return await dialChecked(address, port, deadline);
      } catch (failure) {
        lastFailure = failure;
      }
    }
    throw lastFailure;
  };

  /** The status and refusal header a failed admission answers with. */
  const failureReply = (failure: unknown): { headers: Record<string, string>; status: number } => {
    if (failure instanceof Refused) {
      const { refusal } = failure;
      const refused = refusal.reason === 'destination' ? refusal.addressClass : refusal.reason;
      return {
        headers: { [EGRESS_REFUSAL_HEADER]: refused },
        status: refusal.reason === 'malformed' ? 400 : 403,
      };
    }
    return { headers: {}, status: 502 };
  };

  const tunnel = async (request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> => {
    const reply = (status: number, headers: Record<string, string>): void => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
      const reason = status === 407 ? 'Proxy Authentication Required' : 'Refused';
      client.end(`HTTP/1.1 ${status} ${reason}\r\n${lines.join('')}Content-Length: 0\r\n\r\n`);
    };
    if (!credentialMatches(request.headers, expected)) {
      reply(407, { 'Proxy-Authenticate': REALM });
      return;
    }
    const target = parseAuthority(request.url ?? '');
    if (target === null) {
      const { headers, status } = failureReply(
        refuse({ reason: 'malformed', target: request.url ?? '' })
      );
      reply(status, headers);
      return;
    }
    let upstream: Socket;
    try {
      upstream = await admit(target.host, target.port);
    } catch (failure) {
      const { headers, status } = failureReply(failure);
      reply(status, headers);
      return;
    }
    if (client.destroyed || lifetime.signal.aborted) {
      upstream.destroy();
      client.destroy();
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
  };

  const forward = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const fail = (status: number, headers: Record<string, string>): void => {
      if (!response.headersSent) {
        response.writeHead(status, { ...headers, 'content-length': '0' });
      }
      response.end();
    };
    if (!credentialMatches(request.headers, expected)) {
      fail(407, { 'proxy-authenticate': REALM });
      return;
    }
    const url = absoluteHttpUrl(request.url ?? '');
    if (url === null) {
      const { headers, status } = failureReply(
        refuse({ reason: 'malformed', target: request.url ?? '' })
      );
      fail(status, headers);
      return;
    }
    let upstream: Socket;
    try {
      const port = url.port === '' ? 80 : Number(url.port);
      upstream = await admit(url.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase(), port);
    } catch (failure) {
      const { headers, status } = failureReply(failure);
      fail(status, headers);
      return;
    }
    if (lifetime.signal.aborted) {
      upstream.destroy();
      response.destroy();
      return;
    }
    response.on('close', () => upstream.destroy());
    const forwarded = httpRequest(
      {
        createConnection: () => upstream,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-'))
        ),
        method: request.method,
        path: `${url.pathname}${url.search}`,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.rawHeaders);
        upstreamResponse.pipe(response);
      }
    );
    forwarded.on('error', () => {
      fail(502, {});
      upstream.destroy();
    });
    request.pipe(forwarded);
  };

  const server = createServer();
  // A failure after admission (a socket torn down mid-setup) ends that one
  // connection; it never escapes as an unhandled rejection that would take
  // every agent tab's route down with this process.
  const join = (work: Promise<void>, onFailure: () => void): void => {
    const settled = work.then(() => undefined, onFailure);
    pending.add(settled);
    settled.then(
      () => pending.delete(settled),
      () => pending.delete(settled)
    );
  };
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    join(tunnel(request, client, head), () => client.destroy());
  });
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    join(forward(request, response), () => response.destroy());
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
    admitLoopback: (authorities) => {
      loopback = loopbackKeys(authorities);
    },
    close: async (): Promise<void> => {
      lifetime.abort(new Error('The agent browsing proxy closed'));
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const stream of open) {
        stream.destroy();
      }
      server.closeAllConnections();
      await Promise.all(pending);
      for (const stream of open) {
        stream.destroy();
      }
      await closed;
    },
    port: address.port,
  };
}
