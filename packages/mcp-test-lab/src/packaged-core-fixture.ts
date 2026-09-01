import { createMcpLabFaultPlan } from './faults.js';
import { type McpLabCleanupReport, type McpLabSession, startMcpLabScenario } from './lab.js';
import type { McpLabScenarioId } from './scenario.js';
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
  authorizationDelayObserved(): boolean;
  authorizationDelaySettled(): boolean;
  close(): Promise<PackagedCoreFixtureCleanupReport>;
  readonly manifest: PackagedCoreFixtureManifest;
}
export interface PackagedCoreFixtureOptions {
  readonly authorizationDelayMs?: number;
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
    report.untriggeredFaultIds.length === 0 &&
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
  if (
    options.authorizationDelayMs !== undefined &&
    (!Number.isSafeInteger(options.authorizationDelayMs) ||
      options.authorizationDelayMs < 100 ||
      options.authorizationDelayMs > 10_000)
  ) {
    throw new Error('Packaged core authorization delay must be an integer from 100 to 10000 ms');
  }
  if (options.authorizationDelayMs !== undefined && id !== 'oauth-reference') {
    throw new Error('Packaged core authorization delay is available only for the OAuth fixture');
  }
  const faultPlan =
    options.authorizationDelayMs === undefined
      ? undefined
      : createMcpLabFaultPlan([
          {
            fault: { delayMs: options.authorizationDelayMs, kind: 'delay' },
            id: 'packaged-core-authorization-delay',
            match: { method: 'oauth/authorize', occurrence: 1, phase: 'authorization' },
          },
        ]);
  const session =
    id === 'oauth-reference'
      ? await startMcpLabScenario(id, {
          execution: 'loopback',
          ...(faultPlan ? { faultPlan } : {}),
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
      authorizationDelayObserved: () =>
        faultPlan !== undefined &&
        faultPlan.executionState('packaged-core-authorization-delay') !== 'unobserved',
      authorizationDelaySettled: () => {
        if (!faultPlan) {
          return false;
        }
        const state = faultPlan.executionState('packaged-core-authorization-delay');
        return state === 'aborted' || state === 'settled';
      },
      close: async () => toCleanupReport(await session.close()),
      manifest,
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
