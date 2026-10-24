import {
  createMcpOAuthAuthorizationHold,
  type McpLabCleanupReport,
  type McpLabSession,
  startMcpLabScenario,
} from './lab.ts';
import type { McpLabScenarioId } from './scenario.ts';
export type PackagedCoreFixtureId = Extract<
  McpLabScenarioId,
  'legacy-reference' | 'modern-reference' | 'oauth-reference'
>;
export interface PackagedCoreFixtureManifest {
  readonly authentication: 'none' | 'oauth';
  readonly authorizationUrl?: string;
  readonly protocolVersion: '2025-11-25' | '2026-07-28';
  readonly transport: 'streamable-http';
  readonly url: string;
}
export interface PackagedCoreFixtureCleanupReport {
  readonly clean: boolean;
  readonly httpListenersClosed: number;
  readonly oauthState?: {
    readonly clients: number;
    readonly codes: number;
    readonly states: number;
    readonly tokens: number;
  };
}
export interface PackagedCoreFixture {
  authorizationObserved(): boolean;
  authorizationSettled(): boolean;
  close(): Promise<PackagedCoreFixtureCleanupReport>;
  readonly manifest: PackagedCoreFixtureManifest;
  releaseAuthorization(): void;
}
export interface PackagedCoreFixtureOptions {
  /** Park the first valid OAuth authorization until `releaseAuthorization()`. */
  readonly holdAuthorization?: boolean;
}
function assertLoopbackEndpoint(session: McpLabSession): URL {
  if (
    session.endpoint.kind !== 'loopback-http' &&
    session.endpoint.kind !== 'oauth-loopback-http'
  ) {
    throw new Error(`Packaged fixture ${session.scenario.id} did not create a loopback endpoint`);
  }
  return session.endpoint.url;
}
function toCleanupReport(report: McpLabCleanupReport): PackagedCoreFixtureCleanupReport {
  const oauthState = report.oauthRecordsRemaining;
  const clean =
    report.httpListenersClosed === 1 &&
    report.stdioTransportsClosed === 0 &&
    (oauthState === undefined || Object.values(oauthState).every((count) => count === 0));
  return Object.freeze({
    clean,
    httpListenersClosed: report.httpListenersClosed,
    ...(oauthState ? { oauthState: Object.freeze({ ...oauthState }) } : {}),
  });
}
export async function startPackagedCoreFixture(
  id: PackagedCoreFixtureId,
  options: PackagedCoreFixtureOptions = {}
): Promise<PackagedCoreFixture> {
  if (options.holdAuthorization && id !== 'oauth-reference') {
    throw new Error('Packaged core authorization hold is available only for the OAuth fixture');
  }
  // The packaged cancellation proof keeps authorization pending until the UI cancels it.
  const authorizationHold = options.holdAuthorization
    ? createMcpOAuthAuthorizationHold()
    : undefined;
  const session =
    id === 'oauth-reference'
      ? await startMcpLabScenario(id, {
          execution: 'loopback',
          ...(authorizationHold ? { authorizationHold } : {}),
        })
      : await startMcpLabScenario(id, { execution: 'loopback' });
  try {
    const endpoint = assertLoopbackEndpoint(session);
    const manifest: PackagedCoreFixtureManifest = Object.freeze({
      authentication: session.scenario.authentication,
      ...(session.endpoint.kind === 'oauth-loopback-http'
        ? { authorizationUrl: session.endpoint.authorizationUrl.href }
        : {}),
      protocolVersion: session.scenario.protocol.version,
      transport: 'streamable-http',
      url: endpoint.href,
    });
    return Object.freeze({
      authorizationObserved: () =>
        authorizationHold !== undefined && authorizationHold.state() !== 'unobserved',
      authorizationSettled: () => {
        const state = authorizationHold?.state();
        return state === 'aborted' || state === 'settled';
      },
      close: async () => toCleanupReport(await session.close()),
      manifest,
      releaseAuthorization: () => authorizationHold?.release(),
    });
  } catch (error) {
    try {
      await session.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Packaged core fixture startup failed');
    }
    throw error;
  }
}
