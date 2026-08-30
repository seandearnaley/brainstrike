import { isDeepStrictEqual } from 'node:util';
import type {
  ConfiguredMcpServerId,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
  McpHostWatchFilter,
} from '@brainstrike/assistant-contract';

export interface McpHostPublisherDiagnostic {
  code: 'mcp-host-watch-listener-failed';
  message: 'MCP host watch listener failed';
}

export interface McpHostRevisionPublisherOptions {
  onDiagnostic(diagnostic: McpHostPublisherDiagnostic): void;
}

interface WatchRegistration {
  filter: ReadonlySet<ConfiguredMcpServerId> | undefined;
  listener(event: McpHostWatchEvent): void;
  registeredRevision: number;
}

const HOST_CLOSED_MESSAGE = 'MCP host is closed';

export class McpHostRevisionPublisherClosedError extends Error {
  readonly category = 'host-closed' as const;
  readonly code = 'mcp-host-closed';

  constructor() {
    super(HOST_CLOSED_MESSAGE);
    this.name = 'McpHostRevisionPublisherClosedError';
  }
}

function compareServerIds(left: McpHostServerSnapshot, right: McpHostServerSnapshot): number {
  if (left.configuredServerId === right.configuredServerId) {
    return 0;
  }
  return left.configuredServerId < right.configuredServerId ? -1 : 1;
}

function cloneAndSort(servers: readonly McpHostServerSnapshot[]): readonly McpHostServerSnapshot[] {
  return [...structuredClone(servers)].sort(compareServerIds);
}

export class McpHostRevisionPublisher {
  private closed = false;
  private nextWatchId = 0;
  private revision = 0;
  private servers: readonly McpHostServerSnapshot[] = [];
  private readonly watches = new Map<number, WatchRegistration>();

  constructor(private readonly options: McpHostRevisionPublisherOptions) {}

  snapshot(): McpHostSnapshot {
    return { revision: this.revision, servers: structuredClone(this.servers) };
  }

  publishConfigSet(servers: readonly McpHostServerSnapshot[]): McpHostSnapshot {
    this.assertOpen();
    const nextServers = cloneAndSort(servers);
    if (isDeepStrictEqual(this.servers, nextServers)) {
      return this.snapshot();
    }

    const previousById = new Map(
      this.servers.map((server) => [server.configuredServerId, server] as const)
    );
    const nextById = new Map(
      nextServers.map((server) => [server.configuredServerId, server] as const)
    );
    const affected = new Set([...previousById.keys(), ...nextById.keys()]);
    for (const configuredServerId of affected) {
      if (
        isDeepStrictEqual(previousById.get(configuredServerId), nextById.get(configuredServerId))
      ) {
        affected.delete(configuredServerId);
      }
    }
    return this.publish(nextServers, affected);
  }

  publishActorTransition(server: McpHostServerSnapshot): McpHostSnapshot {
    this.assertOpen();
    const index = this.servers.findIndex(
      ({ configuredServerId }) => configuredServerId === server.configuredServerId
    );
    if (index < 0) {
      throw new Error('Unknown configured MCP server');
    }
    if (isDeepStrictEqual(this.servers[index], server)) {
      return this.snapshot();
    }
    const nextServers = [...this.servers];
    nextServers[index] = structuredClone(server);
    return this.publish(nextServers, new Set([server.configuredServerId]));
  }

  watch(filter: McpHostWatchFilter, listener: (event: McpHostWatchEvent) => void): () => void {
    if (this.closed) {
      throw new McpHostRevisionPublisherClosedError();
    }
    const watchId = this.nextWatchId;
    this.nextWatchId += 1;
    this.watches.set(watchId, {
      filter: filter.configuredServerIds && new Set(filter.configuredServerIds),
      listener,
      registeredRevision: this.revision,
    });
    return () => {
      this.watches.delete(watchId);
    };
  }

  close(): void {
    this.closed = true;
    this.watches.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new McpHostRevisionPublisherClosedError();
    }
  }

  private publish(
    servers: readonly McpHostServerSnapshot[],
    affected: ReadonlySet<ConfiguredMcpServerId>
  ): McpHostSnapshot {
    this.servers = servers;
    this.revision += 1;
    const event = this.snapshot();
    queueMicrotask(() => this.deliver(event, affected));
    return this.snapshot();
  }

  private deliver(event: McpHostWatchEvent, affected: ReadonlySet<ConfiguredMcpServerId>): void {
    for (const registration of this.watches.values()) {
      if (event.revision <= registration.registeredRevision) {
        continue;
      }
      if (registration.filter && ![...registration.filter].some((id) => affected.has(id))) {
        continue;
      }
      const servers = registration.filter
        ? event.servers.filter(({ configuredServerId }) =>
            registration.filter?.has(configuredServerId)
          )
        : event.servers;
      try {
        registration.listener(structuredClone({ revision: event.revision, servers }));
      } catch {
        try {
          this.options.onDiagnostic({
            code: 'mcp-host-watch-listener-failed',
            message: 'MCP host watch listener failed',
          });
        } catch {}
      }
    }
  }
}
