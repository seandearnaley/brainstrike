import type {
  ConfiguredMcpServerId,
  McpHostCloseReport,
  McpHostError,
  McpHostOperation,
  McpHostOperationResult,
  McpHostServerSnapshot,
  McpNegotiatedStatus,
  McpStableErrorCategory,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
export interface McpServerActorClient {
  close(): McpHostCloseReport | Promise<McpHostCloseReport>;
  invoke(operation: McpHostOperation): Promise<unknown>;
  readonly negotiated: McpNegotiatedStatus;
}
interface ClientContext {
  configuredServerId: ConfiguredMcpServerId;
  generation: number;
}
export type McpServerActorClientFactory = (
  context: ClientContext
) => McpServerActorClient | Promise<McpServerActorClient>;
interface McpServerActorOptions extends ClientContext {
  configuredProtocol: '2026-07-28' | 'auto' | 'legacy';
  factory: McpServerActorClientFactory;
  onSnapshotChanged?(snapshot: McpHostServerSnapshot): void;
  transport: 'sse' | 'stdio' | 'streamable-http';
}
type ActorStatus =
  | { state: 'closing' | 'connecting' | 'disconnected' }
  | { error: McpHostError; state: 'error' }
  | { negotiated: McpNegotiatedStatus; state: 'connected' };
class ActorError extends Error {
  constructor(
    readonly category: McpStableErrorCategory,
    readonly code: string
  ) {
    super('MCP server actor operation failed');
    this.name = 'McpServerActorError';
  }
}
const EMPTY_REPORT: McpHostCloseReport = {
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 0,
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
};
export class McpServerActor {
  private readonly closedError = new ActorError('generation-retired', 'mcp-generation-closed');
  private readonly inFlight = new Set<Promise<McpHostOperationResult>>();
  private client: McpServerActorClient | undefined;
  private clientClosePromise: Promise<McpHostCloseReport> | undefined;
  private clientPromise: Promise<McpServerActorClient> | undefined;
  private closePromise: Promise<McpHostCloseReport> | undefined;
  private failure: ActorError | undefined;
  private status: ActorStatus = { state: 'disconnected' };
  constructor(private readonly options: McpServerActorOptions) {}
  close(): Promise<McpHostCloseReport> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = Promise.resolve().then(() => this.closeAfterDrain());
    this.change({ state: 'closing' });
    return this.closePromise;
  }
  invoke(operation: McpHostOperation): Promise<McpHostOperationResult> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closePromise) {
      return Promise.reject(this.closedError);
    }
    if (operation.configuredServerId !== this.options.configuredServerId) {
      return Promise.reject(new ActorError('configuration', 'mcp-configured-server-mismatch'));
    }
    const work = Promise.resolve().then(() => this.invokeAccepted(operation));
    this.inFlight.add(work);
    const remove = () => this.inFlight.delete(work);
    work.then(remove, remove);
    return work;
  }
  snapshot(): McpHostServerSnapshot {
    return structuredClone({
      configuredProtocol: this.options.configuredProtocol,
      configuredServerId: this.options.configuredServerId,
      generation: this.options.generation,
      ...this.status,
      transport: this.options.transport,
    });
  }
  private change(status: ActorStatus): void {
    this.status = status;
    this.options.onSnapshotChanged?.(this.snapshot());
  }
  private fail(error: ActorError): ActorError {
    if (!this.failure) {
      this.failure = error;
      this.change({
        error: { category: error.category, code: error.code, message: error.message },
        state: 'error',
      });
    }
    return this.failure;
  }
  private getClient(): Promise<McpServerActorClient> {
    if (this.clientPromise) {
      return this.clientPromise;
    }
    this.clientPromise = Promise.resolve().then(() => this.createClient());
    this.change({ state: 'connecting' });
    return this.clientPromise;
  }
  private async createClient(): Promise<McpServerActorClient> {
    let client: McpServerActorClient;
    try {
      client = await this.options.factory({
        configuredServerId: this.options.configuredServerId,
        generation: this.options.generation,
      });
    } catch {
      throw this.fail(new ActorError('connection', 'mcp-client-creation-failed'));
    }
    this.client = client;
    let status: McpNegotiatedStatus;
    try {
      status = structuredClone(client.negotiated);
    } catch {
      const cleanupFailed = await this.closeClient(false).then(
        () => false,
        () => true
      );
      throw this.fail(
        new ActorError(
          'protocol',
          cleanupFailed ? 'mcp-negotiated-status-cleanup-failed' : 'mcp-negotiated-status-invalid'
        )
      );
    }
    if (!this.closePromise) {
      this.change({ negotiated: status, state: 'connected' });
    }
    return client;
  }
  private async invokeAccepted(operation: McpHostOperation): Promise<McpHostOperationResult> {
    const client = await this.getClient();
    if (this.failure) {
      throw this.failure;
    }
    let result: unknown;
    try {
      result = await client.invoke(operation);
    } catch {
      throw this.fail(new ActorError('transport', 'mcp-transport-operation-failed'));
    }
    try {
      return parseMcpHostOperationResult({ result, type: operation.type });
    } catch {
      throw this.fail(new ActorError('protocol', 'mcp-result-invalid'));
    }
  }
  private async closeAfterDrain(): Promise<McpHostCloseReport> {
    await Promise.allSettled([...this.inFlight]);
    return this.closeClient();
  }

  private closeClient(memoizeFailure = true): Promise<McpHostCloseReport> {
    if (this.clientClosePromise) {
      return this.clientClosePromise;
    }
    const client = this.client;
    if (!client) {
      return Promise.resolve(structuredClone(EMPTY_REPORT));
    }
    this.clientClosePromise = Promise.resolve().then(async () => {
      try {
        return structuredClone(await client.close());
      } catch {
        const error = new ActorError('transport', 'mcp-client-close-failed');
        throw memoizeFailure ? this.fail(error) : error;
      }
    });
    return this.clientClosePromise;
  }
}
