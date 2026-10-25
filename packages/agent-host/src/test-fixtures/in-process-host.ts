import type { HostClient } from '../client-connection.ts';
import type { HostClientOrigin } from '../ports.ts';
import { type HostPlatformInitializer, type OpenedAgentHost, openAgentHost } from '../runtime.ts';
import { connectInProcessClient } from '../standalone-host.ts';

/** A host over `root` in this test process, and as many clients of it as a test connects. */
export interface InProcessHost extends OpenedAgentHost {
  /** Closes every client this fixture connected, then the host. */
  close(): Promise<void>;
  connect(origin?: HostClientOrigin): Promise<HostClient>;
}
export async function openInProcessHost(
  root: string,
  platform: HostPlatformInitializer
): Promise<InProcessHost> {
  const host = await openAgentHost(root, platform);
  const clients = new Set<HostClient>();
  return {
    bindClientConnection: (connection, origin) => host.bindClientConnection(connection, origin),
    clearAndRetireContent: () => host.clearAndRetireContent(),
    close: async () => {
      await Promise.all([...clients].map((client) => client.close()));
      await host.close();
    },
    connect: async (origin = 'public-socket') => {
      const client = await connectInProcessClient(host, origin);
      clients.add(client);
      return client;
    },
    core: host.core,
  };
}
