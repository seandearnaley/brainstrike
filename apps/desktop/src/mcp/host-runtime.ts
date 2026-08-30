import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
  ExplicitStdioMcpClient,
  type ExplicitStdioMcpClientOptions,
  type NegotiatedProtocolFacts,
} from '@brainstrike/agent/mcp-client';
import {
  type ConfiguredMcpServerId,
  type McpHostCloseReport,
  type McpHostConfig,
  type McpHostOperation,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ResolvedMcpConfig, ResolvedMcpServer } from '../mcp-loader';
import { McpHostRevisionPublisher } from './host-revision-publisher';
import { McpHostService } from './host-service';
import {
  McpServerActor,
  type McpServerActorClient,
  type McpServerActorClientFactory,
} from './server-actor';
import { connectedStatus } from './types';

type ActorContext = Parameters<McpServerActorClientFactory>[0];
type ConfiguredServer = McpHostConfig['servers'][number];
interface ExplicitClient extends NegotiatedProtocolFacts {
  callTool: ExplicitHttpMcpClient['callTool'];
  close: ExplicitHttpMcpClient['close'];
  connect: ExplicitHttpMcpClient['connect'];
  listTools: ExplicitHttpMcpClient['listTools'];
}
interface RuntimeDependencies {
  createActorClient?: (
    server: ResolvedMcpServer,
    context: ActorContext
  ) => ReturnType<McpServerActorClientFactory>;
  createConfigRef?: () => string;
  createHttpTransportClient?: (options: ExplicitHttpMcpClientOptions) => ExplicitClient;
  createStdioTransportClient?: (options: ExplicitStdioMcpClientOptions) => ExplicitClient;
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
const samePrivateConfig = (left: ResolvedMcpServer, right: ResolvedMcpServer): boolean =>
  isDeepStrictEqual({ ...left, enabledTools: undefined }, { ...right, enabledTools: undefined });
const closeReport = (
  transport: ResolvedMcpServer['transport'],
  requestsSettled: number
): McpHostCloseReport =>
  Object.freeze({
    callbacksClosed: 1,
    childProcessesClosed: transport === 'stdio' ? 1 : 0,
    clientsClosed: 1,
    failures: Object.freeze([]),
    loopbackPortsClosed: 0,
    probesClosed: 0,
    requestsSettled,
    subscriptionsClosed: 0,
  });

type ListToolsOperation = Extract<McpHostOperation, { type: 'tools/list' }>;
const listToolsParams = (operation: ListToolsOperation) =>
  operation._meta || operation.cursor
    ? {
        ...(operation._meta ? { _meta: operation._meta } : {}),
        ...(operation.cursor ? { cursor: operation.cursor } : {}),
      }
    : undefined;

async function connectClient(
  client: ExplicitClient,
  server: ResolvedMcpServer,
  context: ActorContext
): Promise<McpServerActorClient> {
  try {
    await client.connect({ signal: context.signal });
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
  const status = connectedStatus(client, {
    configuredProtocol: server.protocol,
    name: server.name,
    transport: server.transport,
  });
  if (status.state !== 'connected') {
    await client.close();
    throw new Error(
      status.state === 'error' ? status.error : 'Connected MCP client has no negotiated status'
    );
  }
  let requestsSettled = 0;
  return {
    async close() {
      await client.close();
      return closeReport(server.transport, requestsSettled);
    },
    async invoke(operation, options) {
      try {
        if (operation.type === 'tools/list') {
          return await client.listTools({ signal: options.signal }, listToolsParams(operation));
        }
        return await client.callTool(
          {
            ...(operation._meta ? { _meta: operation._meta } : {}),
            ...(operation.arguments ? { arguments: operation.arguments } : {}),
            name: operation.toolName,
            ...(operation.task ? { task: operation.task } : {}),
          },
          { resetTimeoutOnProgress: true, signal: options.signal }
        );
      } finally {
        requestsSettled += 1;
      }
    },
    negotiated: status.negotiated,
  };
}

export class DesktopMcpHostRuntime {
  private committedByRef = new Map<string, ResolvedMcpServer>();
  private currentById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
  readonly host: McpHostPort;
  private replacementTail: Promise<void> = Promise.resolve();
  private stagedByRef: Map<string, ResolvedMcpServer> | undefined;
  private readonly createActorClient: NonNullable<RuntimeDependencies['createActorClient']>;
  private readonly createConfigRef: () => string;
  private readonly createHttpTransportClient: NonNullable<
    RuntimeDependencies['createHttpTransportClient']
  >;
  private readonly onInternalError: NonNullable<RuntimeDependencies['onInternalError']>;
  private readonly service: McpHostPort;
  private readonly createStdioTransportClient: NonNullable<
    RuntimeDependencies['createStdioTransportClient']
  >;

  constructor(dependencies: RuntimeDependencies = {}) {
    this.createConfigRef = dependencies.createConfigRef ?? randomUUID;
    this.createHttpTransportClient =
      dependencies.createHttpTransportClient ?? ((options) => new ExplicitHttpMcpClient(options));
    this.createStdioTransportClient =
      dependencies.createStdioTransportClient ?? ((options) => new ExplicitStdioMcpClient(options));
    this.createActorClient =
      dependencies.createActorClient ??
      ((server, context) => this.createExplicitActorClient(server, context));
    this.onInternalError =
      dependencies.onInternalError ??
      ((code, cause) => logger.error('MCP host runtime failure', { cause, code }));
    const publisher = new McpHostRevisionPublisher({
      onDiagnostic: ({ code }, cause) => this.reportInternalError(code, cause),
    });
    this.service = new McpHostService({
      actorFactory: (input) => {
        const server = this.resolveServer(input.config);
        return new McpServerActor({
          configuredProtocol: input.config.configuredProtocol,
          configuredServerId: input.config.configuredServerId,
          factory: (context) => this.createActorClient(server, context),
          generation: input.generation,
          onInternalError: (code, cause) => this.reportInternalError(code, cause),
          onSnapshotChanged: input.onSnapshotChanged,
          transport: input.config.transport.type,
        });
      },
      onInternalError: (code, cause) => this.reportInternalError(code, cause),
      publisher,
    });
    this.host = {
      close: () => this.service.close(),
      invoke: (operation, options) => this.service.invoke(operation, options),
      replaceConfig: (config) =>
        this.enqueueReplacement(async () => await this.service.replaceConfig(config)),
      snapshot: () => this.service.snapshot(),
      watch: (filter, listener) => this.service.watch(filter, listener),
    };
  }

  replaceResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot> {
    const snapshot = structuredClone(config);
    return this.enqueueReplacement(async () => await this.applyResolvedConfig(snapshot));
  }

  private enqueueReplacement<T>(operation: () => Promise<T>): Promise<T> {
    const replacement = this.replacementTail.then(operation);
    this.replacementTail = replacement.then(
      () => undefined,
      () => undefined
    );
    return replacement;
  }

  private async applyResolvedConfig(config: ResolvedMcpConfig): Promise<McpHostSnapshot> {
    const nextById = new Map<ConfiguredMcpServerId, PrivateConfigEntry>();
    const nextByRef = new Map<string, ResolvedMcpServer>();
    const servers = config.servers.map((inputServer): ConfiguredServer => {
      const server = structuredClone(inputServer);
      const configuredServerId = parseConfiguredMcpServerId(server.name);
      const previous = this.currentById.get(configuredServerId);
      const configRef =
        previous && samePrivateConfig(previous.server, server)
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
      const snapshot = await this.service.replaceConfig({ servers });
      this.currentById = nextById;
      this.committedByRef = nextByRef;
      return snapshot;
    } finally {
      this.stagedByRef = undefined;
    }
  }

  private resolveServer(config: ConfiguredServer): ResolvedMcpServer {
    // A reused ref can differ only by enabledTools, which stays in the public config.
    const server =
      this.stagedByRef?.get(config.transport.configRef) ??
      this.committedByRef.get(config.transport.configRef);
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
    return structuredClone(server);
  }

  private reportInternalError(code: string, cause: unknown): void {
    try {
      const pending = this.onInternalError(code, cause);
      if (pending) {
        void pending.catch((diagnosticCause: unknown) => {
          logger.error('MCP host diagnostic sink rejected', { cause: diagnosticCause, code });
        });
      }
    } catch (diagnosticCause) {
      logger.error('MCP host diagnostic sink threw', { cause: diagnosticCause, code });
    }
  }

  private createExplicitActorClient(
    server: ResolvedMcpServer,
    context: ActorContext
  ): Promise<McpServerActorClient> {
    const common = {
      clientInfo: { name: `brainstrike-desktop-${server.name}`, version: '0.1.0' },
      name: server.name,
      onUnexpectedClose: context.onUnexpectedClose,
      protocol: server.protocol,
    };
    const client =
      server.transport === 'stdio'
        ? this.createStdioTransportClient({
            ...common,
            ...(server.args ? { args: server.args } : {}),
            command: server.command,
            ...(server.env ? { env: server.env } : {}),
          })
        : this.createHttpTransportClient({
            ...common,
            ...(server.headers ? { headers: server.headers } : {}),
            lifecycle: 'host-owned',
            transport: server.transport,
            url: server.url,
          });
    return connectClient(client, server, context);
  }
}

export const createDesktopMcpHostRuntime = (
  dependencies?: RuntimeDependencies
): DesktopMcpHostRuntime => new DesktopMcpHostRuntime(dependencies);

let singleton: DesktopMcpHostRuntime | undefined;
export const getDesktopMcpHostRuntime = (): DesktopMcpHostRuntime =>
  (singleton ??= createDesktopMcpHostRuntime());
