/**
 * MCP transport connection and cleanup for the desktop host runtime, split out
 * of `host-runtime.ts` to keep that file within its size budget. Owns the
 * negotiated-client shape, the ordered close accounting, and the failure paths
 * that must still flush stdio diagnostics.
 */
import type {
  ExplicitHttpMcpClient,
  McpClientExtensionRegistry,
  NegotiatedProtocolFacts,
} from '@brainstrike/agent/mcp-client';
import type { McpHostCloseReport } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ResolvedMcpServer } from '../mcp-loader';
import { createMcpCoreServerFeatures, type McpCoreFeatureClient } from './core-server-features';
import { classifyMcpConnectFailure } from './lifecycle-errors';
import type { McpOAuthClientProvider, McpOAuthCloseProof } from './oauth-client-provider';
import {
  type McpServerActorClient,
  McpServerActorClientCleanupError,
  type McpServerActorClientFactory,
} from './server-actor';
import type { McpStdioDiagnosticCollector } from './stdio-diagnostics';
import { connectedStatus } from './types';

type ActorContext = Parameters<McpServerActorClientFactory>[0];

const logger = createLogger('DesktopMcpHostConnection');

export interface ExplicitClient extends NegotiatedProtocolFacts {
  callTool: McpCoreFeatureClient['callTool'];
  close: ExplicitHttpMcpClient['close'];
  complete: McpCoreFeatureClient['complete'];
  connect: ExplicitHttpMcpClient['connect'];
  getPrompt: McpCoreFeatureClient['getPrompt'];
  listen: McpCoreFeatureClient['listen'];
  /** Present on both production clients; required whenever an extension registry is attached. */
  listenTasks?: ExplicitHttpMcpClient['listenTasks'];
  listPrompts: McpCoreFeatureClient['listPrompts'];
  listResources: McpCoreFeatureClient['listResources'];
  listResourceTemplates: McpCoreFeatureClient['listResourceTemplates'];
  listTools: McpCoreFeatureClient['listTools'];
  readResource: McpCoreFeatureClient['readResource'];
  requestExtension?: ExplicitHttpMcpClient['requestExtension'];
  subscribeResource: McpCoreFeatureClient['subscribeResource'];
  unsubscribeResource: McpCoreFeatureClient['unsubscribeResource'];
  watchServerFeatures: McpCoreFeatureClient['watchServerFeatures'];
}

const successfulCloseReport = (
  transport: ResolvedMcpServer['transport'],
  requestsSettled: number,
  subscriptionsClosed: number,
  oauthProof?: McpOAuthCloseProof
): McpHostCloseReport =>
  Object.freeze({
    callbacksClosed: 1 + (oauthProof?.callbacksClosed ?? 0),
    childProcessesClosed: transport === 'stdio' ? 1 : 0,
    clientsClosed: 1,
    failures: Object.freeze([]),
    loopbackPortsClosed: oauthProof?.loopbackPortsClosed ?? 0,
    probesClosed: 0,
    requestsSettled,
    subscriptionsClosed,
  });

async function closeClientResources(
  client: ExplicitClient,
  provider?: McpOAuthClientProvider
): Promise<McpOAuthCloseProof | undefined> {
  const failures: unknown[] = [];
  let oauthProof: McpOAuthCloseProof | undefined;
  try {
    await client.close();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    oauthProof = await provider?.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'MCP client resources failed to close');
  }
  return oauthProof;
}

async function closeAfterFailure(
  client: ExplicitClient,
  cause: unknown,
  provider?: McpOAuthClientProvider
): Promise<never> {
  try {
    await closeClientResources(client, provider);
  } catch (cleanupCause) {
    throw new McpServerActorClientCleanupError(
      [cause, cleanupCause],
      'MCP client operation failed and cleanup also failed'
    );
  }
  throw cause;
}

async function closeAfterConnectFailure(
  client: ExplicitClient,
  cause: unknown,
  server: ResolvedMcpServer,
  generation: number,
  diagnostics?: McpStdioDiagnosticCollector,
  provider?: McpOAuthClientProvider
): Promise<never> {
  const cleanupFailures: unknown[] = [];
  try {
    await closeClientResources(client, provider);
  } catch (cleanupCause) {
    cleanupFailures.push(cleanupCause);
  } finally {
    // A child can close the protocol stream before Node drains its final
    // stderr chunks. Flush after transport cleanup so both the user-facing
    // classification and durable report use the same complete diagnostics.
    diagnostics?.flush();
    reportStdioFailureDiagnostics(server, generation, diagnostics);
  }
  const failure = classifyMcpConnectFailure(cause, diagnostics?.snapshot(), {
    requiresReauthorization: provider?.requiresReauthorization() === true,
    server: server.name,
  });
  if (cleanupFailures.length > 0) {
    throw new McpServerActorClientCleanupError(
      [failure, ...cleanupFailures],
      'MCP client operation failed and cleanup also failed'
    );
  }
  throw failure;
}

export interface TransportActorClient extends McpServerActorClient {
  readonly transportClient: ExplicitClient;
}

export async function connectClient(
  client: ExplicitClient,
  server: ResolvedMcpServer,
  context: ActorContext,
  onInternalError: (code: string, cause: unknown) => void,
  extensionRegistry: McpClientExtensionRegistry | undefined,
  diagnostics?: McpStdioDiagnosticCollector,
  provider?: McpOAuthClientProvider,
  onConnected?: () => Promise<void>
): Promise<TransportActorClient> {
  try {
    await client.connect({
      signal: context.signal,
      ...(server.startup === 'automatic' || context.interactiveAuthorization !== true
        ? { timeout: 10_000 }
        : {}),
    });
    await onConnected?.();
  } catch (cause) {
    return await closeAfterConnectFailure(
      client,
      cause,
      server,
      context.generation,
      diagnostics,
      provider
    );
  }
  diagnostics?.flush();
  const status = connectedStatus(client, {
    configuredProtocol: server.protocol,
    name: server.name,
    transport: server.transport,
  });
  if (status.state !== 'connected') {
    return await closeAfterFailure(
      client,
      new Error(
        status.state === 'error' ? status.error : 'Connected MCP client has no negotiated status'
      ),
      provider
    );
  }
  const catalogListeners = new Set<(catalog: ReturnType<typeof features.snapshot>) => void>();
  const features = createMcpCoreServerFeatures(client, {
    extensionRegistry,
    onCatalogChanged: (catalog) => {
      for (const listener of catalogListeners) {
        listener(catalog);
      }
    },
    onInternalError,
    signal: context.signal,
  });
  try {
    await features.initialize();
  } catch (cause) {
    return await closeAfterFailure(client, cause, provider);
  }
  let requestsSettled = 0;
  return {
    catalog: () => features.snapshot(),
    async close() {
      try {
        const errors: unknown[] = [];
        let oauthProof: McpOAuthCloseProof | undefined;
        let subscriptionsClosed = 0;
        try {
          subscriptionsClosed = (await features.close()).subscriptionsClosed;
        } catch (cause) {
          errors.push(cause);
        }
        catalogListeners.clear();
        try {
          oauthProof = await closeClientResources(client, provider);
        } catch (cause) {
          errors.push(cause);
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Closing MCP core features and client failed');
        }
        return successfulCloseReport(
          server.transport,
          requestsSettled,
          subscriptionsClosed,
          oauthProof
        );
      } finally {
        diagnostics?.flush();
      }
    },
    async invoke(operation, options) {
      try {
        return await features.invoke(operation, options);
      } finally {
        requestsSettled += 1;
      }
    },
    negotiated: status.negotiated,
    transportClient: client,
    watchCatalog(listener) {
      catalogListeners.add(listener);
      return () => catalogListeners.delete(listener);
    },
  };
}

export function reportStdioFailureDiagnostics(
  server: ResolvedMcpServer,
  generation: number,
  diagnostics?: McpStdioDiagnosticCollector
): void {
  const report = diagnostics?.takeFailureReport();
  if (!report) {
    return;
  }
  logger.warn('MCP stdio failure diagnostics', {
    diagnostics: report.diagnostics,
    generation,
    omittedDiagnostics: report.omittedDiagnostics,
    server: server.name,
  });
}
