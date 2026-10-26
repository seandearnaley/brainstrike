import { PassThrough } from 'node:stream';
import { createLogger } from '@brainstrike/logging';
import { authenticateHostClient, type HostClient } from './client-connection.ts';
import type { HostPlatformLaunchOptions } from './platform-launch-options.ts';
import type { HostClientOrigin } from './ports.ts';
import { loadHostPlatform } from './process-entry.ts';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_VERSION } from './protocol.ts';
import { type OpenedAgentHost, openAgentHost } from './runtime.ts';
import { stdioConnection } from './transports.ts';

const logger = createLogger('AgentHost');

/** A client of a host this process opened, and that host's close. */
export interface StandaloneHost {
  readonly client: HostClient;
  close(): Promise<void>;
  /** Settles once no run, child or pending wake holds the host. */
  idle(): Promise<void>;
}
/**
 * Runs an agent host in this process, as Claude Code and Codex run their agent:
 * the host lives exactly as long as its opener keeps it. Its client speaks the
 * same JSON-RPC schema over an in-memory stream pair, holding that stream as
 * its authority. A data root another process holds is refused by its lock.
 */
export async function openStandaloneHost(
  root: string,
  platformModule: string,
  platformOptions: HostPlatformLaunchOptions
): Promise<StandaloneHost> {
  const host = await openAgentHost(root, (context) =>
    loadHostPlatform(platformModule, { root }, context, platformOptions)
  );
  let client: HostClient;
  try {
    client = await connectInProcessClient(host, 'public-socket');
  } catch (cause) {
    // ADR-0031: the failure is reported first. The host's close goes on, holding
    // the data root until it ends, and a failed close is logged.
    host.close().catch((failure: unknown) => {
      logger.error('Standalone host close after a failed connect failed', {
        errorName: failure instanceof Error ? failure.name : typeof failure,
      });
    });
    throw cause;
  }
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } finally {
        await host.close();
      }
    },
    idle: () => host.core.holds.idle(),
  };
}
/**
 * A client of `host` over an in-memory stream pair, as `origin`: the same JSON-RPC schema
 * as any other transport, and holding the stream is its authority.
 */
export async function connectInProcessClient(
  host: OpenedAgentHost,
  origin: HostClientOrigin
): Promise<HostClient> {
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const unbind = host.bindClientConnection(stdioConnection(toHost, toClient), origin);
  const transportClosed = Promise.withResolvers<void>();
  const closeTransport = async (): Promise<void> => {
    toHost.destroy();
    toClient.destroy();
    unbind();
    transportClosed.resolve();
  };
  try {
    return await authenticateHostClient(
      stdioConnection(toClient, toHost),
      { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
      closeTransport,
      transportClosed.promise
    );
  } catch (cause) {
    await closeTransport();
    throw cause;
  }
}
