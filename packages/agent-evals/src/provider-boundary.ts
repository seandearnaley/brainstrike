/**
 * The host's provider egress for one eval: a loopback server every base-URL
 * knob points at. With a cassette it replays it through the canonical replay
 * (`createProviderCassetteReplay`); without one it refuses every request, so a
 * scripted run that reached for a provider fails visibly instead of calling it.
 */
import { createServer, type Server } from 'node:http';
import {
  createProviderCassetteReplay,
  describeProviderRequestKey,
  PROVIDER_CASSETTE_UPSTREAMS,
  type ProviderCassette,
  type ProviderCassetteKnob,
  type ProviderCassetteSubstitution,
  parseProviderCassettePath,
  readBody,
} from '@brainstrike/test-utils/provider-cassette';

export interface ProviderBoundary {
  readonly close: () => Promise<void>;
  /** Every base-URL knob, pointed at this boundary. */
  readonly env: Readonly<Record<ProviderCassetteKnob, string>>;
  /** Each refused request, described by its key. */
  readonly refusals: () => readonly string[];
  /** Recorded exchanges no request claimed. */
  readonly unserved: () => readonly string[];
}

export async function startProviderBoundary(options: {
  readonly cassette?: ProviderCassette;
  readonly substitutions: readonly ProviderCassetteSubstitution[];
}): Promise<ProviderBoundary> {
  const replay = options.cassette
    ? createProviderCassetteReplay(options.cassette, { substitutions: options.substitutions })
    : undefined;
  const refusals: string[] = [];
  const server: Server = createServer((request, response) => {
    const refuse = (reason: string): void => {
      refusals.push(reason);
      if (!response.headersSent) {
        response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      response.end(JSON.stringify({ error: { message: reason, type: 'eval_provider_boundary' } }));
    };
    const path = parseProviderCassettePath(request.url);
    readBody(request)
      .then(async (rawBody) => {
        if (!path) {
          refuse(`${request.method} ${request.url} names no provider base-URL knob`);
          return;
        }
        if (!replay) {
          refuse(`${path.knob}${path.route}: scripted mode makes no provider request`);
          return;
        }
        const refused = await replay.serve({
          knob: path.knob,
          method: request.method ?? 'GET',
          rawBody,
          response,
          route: path.route,
        });
        if (refused) {
          refuse(`unrecorded exchange ${describeProviderRequestKey(refused.key)}`);
        }
      })
      .catch((cause: unknown) => refuse(`replay failed: ${String(cause)}`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('The provider boundary has no assigned port');
  }
  const base = `http://127.0.0.1:${address.port}`;
  const knobs = Object.keys(PROVIDER_CASSETTE_UPSTREAMS) as ProviderCassetteKnob[];
  return {
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    env: Object.fromEntries(knobs.map((knob) => [knob, `${base}/${knob}`])) as Record<
      ProviderCassetteKnob,
      string
    >,
    refusals: () => [...refusals],
    unserved: () =>
      (replay?.unserved() ?? []).map((exchange) => describeProviderRequestKey(exchange.key)),
  };
}
