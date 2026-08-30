import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ConfiguredMcpServerId,
  type McpHostConfig,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';
import { McpHostRevisionPublisher } from './host-revision-publisher';
import { McpHostService } from './host-service';
import { McpServerActor, type McpServerActorClientFactory } from './server-actor';

type ActorContext = Parameters<McpServerActorClientFactory>[0];
type ConfiguredServer = McpHostConfig['servers'][number];
interface RuntimeDependencies {
  createActorClient: (
    server: ResolvedMcpServer,
    context: ActorContext
  ) => ReturnType<McpServerActorClientFactory>;
  createConfigRef?: () => string;
  onInternalError?: (code: string, cause: unknown) => Promise<void> | void;
}
interface PrivateConfigEntry {
  configRef: string;
  server: ResolvedMcpServer;
}
type ConfigRefErrorCode =
  | 'mcp-config-ref-protocol-mismatch'
  | 'mcp-config-ref-server-mismatch'
  | 'mcp-config-ref-transport-mismatch'
  | 'mcp-config-ref-unknown';
class ConfigRefError extends Error {
  readonly category = 'configuration' as const;
  constructor(readonly code: ConfigRefErrorCode) {
    super('MCP private configuration reference is invalid');
    this.name = 'McpConfigRefError';
  }
}

const logger = createLogger('DesktopMcpHostRuntime');

export class DesktopMcpHostRuntime {
  private committedByRef = new Map<string, ResolvedMcpServer>();
  private currentById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
  readonly host: McpHostPort;
  private replacementTail: Promise<void> = Promise.resolve();
  private stagedByRef: Map<string, ResolvedMcpServer> | undefined;
  private readonly createActorClient: RuntimeDependencies['createActorClient'];
  private readonly createConfigRef: () => string;
  private readonly onInternalError: NonNullable<RuntimeDependencies['onInternalError']>;

  constructor(dependencies: RuntimeDependencies) {
    this.createActorClient = dependencies.createActorClient;
    this.createConfigRef = dependencies.createConfigRef ?? randomUUID;
    this.onInternalError =
      dependencies.onInternalError ??
      ((code, cause) => logger.error('MCP host runtime failure', { cause, code }));
    const publisher = new McpHostRevisionPublisher({
      onDiagnostic: ({ code }, cause) => this.onInternalError(code, cause),
    });
    this.host = new McpHostService({
      actorFactory: (input) => {
        const server = this.resolveServer(input.config);
        return new McpServerActor({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          factory: (context) => this.createActorClient(server, context),
          generation: input.generation,
          onInternalError: this.onInternalError,
          onSnapshotChanged: input.onSnapshotChanged,
          transport: input.config.transport.type,
        });
      },
      onInternalError: this.onInternalError,
      publisher,
    });
  }

  replaceResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot> {
    const replacement = this.replacementTail.then(() => this.applyResolvedConfig(config));
    this.replacementTail = replacement.then(
      () => undefined,
      () => undefined
    );
    return replacement;
  }

  private async applyResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot> {
    const nextById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
    const nextByRef = new Map<string, ResolvedMcpServer>();
    const servers = config.servers.map((server): ConfiguredServer => {
      const configuredServerId = parseConfiguredMcpServerId(server.name);
      const previous = this.currentById.get(configuredServerId);
      const configRef =
        previous && isDeepStrictEqual(previous.server, server)
          ? previous.configRef
          : this.createConfigRef();
      nextById.set(configuredServerId, { configRef, server });
      nextByRef.set(configRef, server);
      return {
        auth: { type: 'none' },
        configuredProtocol: server.protocol,
        configuredServerId,
        ...(server.enabledTools ? { enabledTools: server.enabledTools } : {}),
        transport: { configRef, type: server.transport },
      };
    });
    this.stagedByRef = nextByRef;
    try {
      const snapshot = await this.host.replaceConfig({ servers });
      this.currentById = nextById;
      this.committedByRef = nextByRef;
      return snapshot;
    } finally {
      this.stagedByRef = undefined;
    }
  }

  private resolveServer(config: ConfiguredServer): ResolvedMcpServer {
    const server = (this.stagedByRef ?? this.committedByRef).get(config.transport.configRef);
    if (!server) {
      throw new ConfigRefError('mcp-config-ref-unknown');
    }
    if (server.name !== config.configuredServerId) {
      throw new ConfigRefError('mcp-config-ref-server-mismatch');
    }
    if (server.protocol !== config.configuredProtocol) {
      throw new ConfigRefError('mcp-config-ref-protocol-mismatch');
    }
    if (server.transport !== config.transport.type) {
      throw new ConfigRefError('mcp-config-ref-transport-mismatch');
    }
    return server;
  }
}

export const createDesktopMcpHostRuntime = (
  dependencies: RuntimeDependencies
): DesktopMcpHostRuntime => new DesktopMcpHostRuntime(dependencies);
