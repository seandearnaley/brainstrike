import { PassThrough } from 'node:stream';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { authenticateHostClient, type HostClient } from './client-connection.ts';
import type { HostPlatformLaunchOptions } from './platform-launch-options.ts';
import { loadHostPlatform } from './process-entry.ts';
import { AGENT_HOST_PROTOCOL_VERSION } from './protocol.ts';
import { openAgentHost } from './runtime.ts';
import { stdioConnection } from './transports.ts';

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
  const options = { lifetime: 'persistent', root } as const;
  const host = await openAgentHost(root, (context) =>
    loadHostPlatform(platformModule, options, context, platformOptions)
  );
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const unbind = host.bindClientConnection(stdioConnection(toHost, toClient), 'public-socket');
  const transportClosed = Promise.withResolvers<void>();
  const closeTransport = async (): Promise<void> => {
    toHost.destroy();
    toClient.destroy();
    transportClosed.resolve();
  };
  let client: HostClient;
  try {
    client = await authenticateHostClient(
      stdioConnection(toClient, toHost),
      { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
      closeTransport,
      transportClosed.promise
    );
  } catch (cause) {
    await closeTransport();
    unbind();
    await host.close();
    throw cause;
  }
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } finally {
        unbind();
        await host.close();
      }
    },
    idle: () => host.core.holds.idle(),
  };
}
