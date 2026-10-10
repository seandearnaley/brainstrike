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
  onDiagnostic(diagnostic: McpHostPublisherDiagnostic, cause: unknown): Promise<void> | void;
}

interface WatchRegistration {
  filter: ReadonlySet<ConfiguredMcpServerId> | undefined;
  listener(event: McpHostWatchEvent): Promise<void> | void;
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

type TransitionErrorCode =
  | 'mcp-host-actor-config-mismatch'
  | 'mcp-host-future-generation'
  | 'mcp-host-server-unknown'
  | 'mcp-host-stale-generation';
export class McpHostRevisionPublisherTransitionError extends Error {
  readonly category: 'configuration' | 'generation-retired';
  constructor(
    readonly code: TransitionErrorCode,
    configuredServerId?: string
  ) {
    super(configuredServerId ? `${code}: ${configuredServerId}` : code);
    this.name = 'McpHostRevisionPublisherTransitionError';
    this.category =
      code === 'mcp-host-stale-generation' || code === 'mcp-host-future-generation'
        ? 'generation-retired'
        : 'configuration';
  }
}

export class McpHostRevisionPublisherWatchError extends Error {
  readonly category = 'configuration' as const;
  readonly code = 'mcp-host-empty-watch-filter';

  constructor() {
    super('mcp-host-empty-watch-filter');
    this.name = 'McpHostRevisionPublisherWatchError';
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
  private retiredWatches = 0;
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
      throw new McpHostRevisionPublisherTransitionError(
        'mcp-host-server-unknown',
        server.configuredServerId
      );
    }
    const current = this.servers[index];
    if (!current) {
      throw new Error('MCP host publisher server index invariant failed');
    }
    if (server.generation < current.generation) {
      throw new McpHostRevisionPublisherTransitionError(
        'mcp-host-stale-generation',
        server.configuredServerId
      );
    }
    if (server.generation > current.generation) {
      throw new McpHostRevisionPublisherTransitionError(
        'mcp-host-future-generation',
        server.configuredServerId
      );
    }
    if (
      server.configuredProtocol !== current.configuredProtocol ||
      server.transport !== current.transport
    ) {
      throw new McpHostRevisionPublisherTransitionError(
        'mcp-host-actor-config-mismatch',
        server.configuredServerId
      );
    }
    if (isDeepStrictEqual(current, server)) {
      return this.snapshot();
    }
    const nextServers = [...this.servers];
    nextServers[index] = structuredClone(server);
    return this.publish(nextServers, new Set([server.configuredServerId]));
  }

  watch(
    filter: McpHostWatchFilter,
    listener: (event: McpHostWatchEvent) => Promise<void> | void
  ): () => void {
    if (this.closed) {
      throw new McpHostRevisionPublisherClosedError();
    }
    if (filter.configuredServerIds?.length === 0) {
      throw new McpHostRevisionPublisherWatchError();
    }
    const watchId = this.nextWatchId;
    this.nextWatchId += 1;
    this.watches.set(watchId, {
      filter: filter.configuredServerIds && new Set(filter.configuredServerIds),
      listener,
      registeredRevision: this.revision,
    });
    return () => {
      if (this.watches.delete(watchId)) {
        this.retiredWatches += 1;
      }
    };
  }

  close(): number {
    if (this.closed) {
      return 0;
    }
    this.closed = true;
    // The closed watch DTO has no terminal variant; terminal host close invalidates registrations.
    const subscriptionsClosed = this.retiredWatches + this.watches.size;
    this.retiredWatches = 0;
    this.watches.clear();
    return subscriptionsClosed;
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
    const revision = this.revision + 1;
    const queuedEvent = structuredClone({ revision, servers });
    const returnedEvent = structuredClone(queuedEvent);
    this.servers = servers;
    this.revision = revision;
    queueMicrotask(() => this.deliver(queuedEvent, affected));
    return returnedEvent;
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
        const delivery = registration.listener(
          structuredClone({ revision: event.revision, servers })
        );
        void Promise.resolve(delivery).catch((cause: unknown) =>
          this.reportWatchListenerFailure(cause)
        );
      } catch (cause) {
        this.reportWatchListenerFailure(cause);
      }
    }
  }

  private reportWatchListenerFailure(cause: unknown): void {
    try {
      const reporting = this.options.onDiagnostic(
        {
          code: 'mcp-host-watch-listener-failed',
          message: 'MCP host watch listener failed',
        },
        cause
      );
      void Promise.resolve(reporting).catch(() => {});
    } catch {}
  }
}
