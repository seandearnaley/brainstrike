import type {
  ConfiguredMcpServerId,
  McpHostCloseReport,
  McpHostError,
  McpHostInvokeOptions,
  McpHostOperation,
  McpHostOperationResult,
  McpHostServerSnapshot,
  McpNegotiatedStatus,
  McpStableErrorCategory,
} from '@brainstrike/assistant-contract';
import {
  parseMcpHostCloseReport,
  parseMcpHostOperationResult,
  parseMcpNegotiatedStatus,
} from '@brainstrike/assistant-contract/mcp-host-runtime';
export interface McpServerActorClient {
  close(): McpHostCloseReport | Promise<McpHostCloseReport>;
  invoke(operation: McpHostOperation, options: { signal: AbortSignal }): Promise<unknown>;
  readonly negotiated: McpNegotiatedStatus;
}
interface ClientContext {
  configuredServerId: ConfiguredMcpServerId;
  generation: number;
  onUnexpectedClose(): void;
  signal: AbortSignal;
}
export type McpServerActorClientFactory = (
  context: ClientContext
) => McpServerActorClient | Promise<McpServerActorClient>;
interface McpServerActorOptions extends Pick<ClientContext, 'configuredServerId' | 'generation'> {
  configuredProtocol: '2026-07-28' | 'auto' | 'legacy';
  factory: McpServerActorClientFactory;
  /**
   * Main-process-only diagnostic sink. The cause is RAW and UNSANITIZED and may
   * contain auth headers, tokens in URLs, or stdio argv. Never forward it to a
   * renderer or persist it without the platform redaction path.
   */
  onInternalError(code: McpServerActorDiagnosticCode, cause: unknown): void;
  onSnapshotChanged?(snapshot: McpHostServerSnapshot): void;
  transport: 'sse' | 'stdio' | 'streamable-http';
}
type ActorStatus =
  | { state: 'closing' | 'connecting' | 'disconnected' }
  | { error: McpHostError; state: 'error' }
  | { negotiated: McpNegotiatedStatus; state: 'connected' };
type McpServerActorErrorCode =
  | 'mcp-client-close-failed'
  | 'mcp-client-close-report-invalid'
  | 'mcp-client-close-reported-failures'
  | 'mcp-client-creation-failed'
  | 'mcp-configured-server-mismatch'
  // Stable BST-1504 cross-process code; the underscore spelling is intentional.
  | 'mcp_generation_retired'
  | 'mcp-negotiated-status-cleanup-failed'
  | 'mcp-negotiated-status-invalid'
  | 'mcp-result-invalid'
  | 'mcp-transport-closed'
  | 'mcp-transport-operation-failed';
type McpServerActorDiagnosticCode = McpServerActorErrorCode | 'mcp-snapshot-listener-failed';
class ActorError extends Error {
  constructor(
    readonly category: McpStableErrorCategory,
    readonly code: McpServerActorErrorCode
  ) {
    super('MCP server actor operation failed');
    this.name = 'McpServerActorError';
  }
}
function freezeCloseReport(report: McpHostCloseReport): McpHostCloseReport {
  const failures = Object.freeze(report.failures.map((failure) => Object.freeze({ ...failure })));
  return Object.freeze({ ...report, failures });
}
const EMPTY_REPORT: McpHostCloseReport = freezeCloseReport({
  callbacksClosed: 0,
  childProcessesClosed: 0,
  clientsClosed: 0,
  failures: [],
  loopbackPortsClosed: 0,
  probesClosed: 0,
  requestsSettled: 0,
  subscriptionsClosed: 0,
});
export class McpServerActor {
  private readonly generationAbort = new AbortController();
  private readonly inFlight = new Set<Promise<McpHostOperationResult>>();
  private readonly retiredError = new ActorError('generation-retired', 'mcp_generation_retired');
  private client: McpServerActorClient | undefined;
  private clientClosePromise: Promise<McpHostCloseReport> | undefined;
  private clientPromise: Promise<McpServerActorClient> | undefined;
  private closePromise: Promise<McpHostCloseReport> | undefined;
  private failure: ActorError | undefined;
  private transportInvalidated = false;
  private status: ActorStatus = { state: 'disconnected' };
  constructor(private readonly options: McpServerActorOptions) {}
  close(): Promise<McpHostCloseReport> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = Promise.resolve().then(() => this.closeAfterDrain());
    this.retireGeneration();
    if (!this.failure) {
      this.change({ state: 'closing' });
    }
    return this.closePromise;
  }
  invalidated(): boolean {
    return this.transportInvalidated;
  }
  invoke(
    operation: McpHostOperation,
    options?: McpHostInvokeOptions
  ): Promise<McpHostOperationResult> {
    if (this.closePromise || this.generationAbort.signal.aborted || this.transportInvalidated) {
      return Promise.reject(this.retiredError);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (operation.configuredServerId !== this.options.configuredServerId) {
      // Caller misrouting is rejected without poisoning this server generation.
      return Promise.reject(new ActorError('configuration', 'mcp-configured-server-mismatch'));
    }
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    const signal = options?.signal
      ? AbortSignal.any([this.generationAbort.signal, options.signal])
      : this.generationAbort.signal;
    const work = Promise.resolve().then(() => this.runAccepted(operation, signal, options?.signal));
    const lease = this.settleOnAbort(work, signal);
    this.inFlight.add(work);
    const remove = () => this.inFlight.delete(work);
    work.then(remove, remove);
    return lease;
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
    try {
      this.options.onSnapshotChanged?.(this.snapshot());
    } catch (cause) {
      this.diagnose('mcp-snapshot-listener-failed', cause);
    }
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
        onUnexpectedClose: () => this.invalidateTransport(),
        signal: this.generationAbort.signal,
      });
    } catch (cause) {
      this.throwIfAborted();
      const error = new ActorError('connection', 'mcp-client-creation-failed');
      this.diagnose(error.code, cause);
      throw this.fail(error);
    }
    this.client = client;
    this.throwIfAborted();
    let status: McpNegotiatedStatus;
    try {
      status = parseMcpNegotiatedStatus(client.negotiated);
    } catch (cause) {
      const cleanupReport = await this.closeClient(false);
      const cleanupFailed = cleanupReport.failures.length > 0;
      const error = new ActorError(
        'protocol',
        cleanupFailed ? 'mcp-negotiated-status-cleanup-failed' : 'mcp-negotiated-status-invalid'
      );
      this.diagnose(error.code, cause);
      throw this.fail(error);
    }
    if (!this.closePromise) {
      this.change({ negotiated: status, state: 'connected' });
    }
    return client;
  }
  private async runAccepted(
    operation: McpHostOperation,
    signal: AbortSignal,
    callerSignal?: AbortSignal
  ): Promise<McpHostOperationResult> {
    const client = await this.getClient();
    this.throwIfAborted(callerSignal);
    if (this.failure) {
      throw this.failure;
    }
    let result: unknown;
    try {
      result = await client.invoke(operation, { signal });
    } catch (cause) {
      this.throwIfAborted(callerSignal);
      const error = new ActorError('transport', 'mcp-transport-operation-failed');
      this.diagnose(error.code, cause);
      this.fail(error);
      throw error;
    }
    this.throwIfAborted(callerSignal);
    try {
      return parseMcpHostOperationResult({ result, type: operation.type });
    } catch (cause) {
      this.throwIfAborted(callerSignal);
      const error = new ActorError('protocol', 'mcp-result-invalid');
      this.diagnose(error.code, cause);
      throw this.fail(error);
    }
  }
  private invalidateTransport(): void {
    if (this.closePromise || this.transportInvalidated) {
      return;
    }
    this.transportInvalidated = true;
    this.fail(new ActorError('connection', 'mcp-transport-closed'));
  }
  private retireGeneration(): void {
    if (!this.generationAbort.signal.aborted) {
      this.generationAbort.abort(this.retiredError);
    }
  }
  private settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    return Promise.race([work, aborted.promise]).finally(() =>
      signal.removeEventListener('abort', onAbort)
    );
  }
  private throwIfAborted(callerSignal?: AbortSignal): void {
    if (this.generationAbort.signal.aborted) {
      throw this.retiredError;
    }
    callerSignal?.throwIfAborted();
  }
  private async closeAfterDrain(): Promise<McpHostCloseReport> {
    await Promise.allSettled([...this.inFlight]);
    const report = await this.closeClient();
    if (!this.failure) {
      this.change({ state: 'disconnected' });
    }
    return report;
  }

  private diagnose(code: McpServerActorDiagnosticCode, cause: unknown): void {
    try {
      this.options.onInternalError(code, cause);
    } catch {}
  }

  private closeFailureReport(error: ActorError): McpHostCloseReport {
    return freezeCloseReport({
      ...EMPTY_REPORT,
      failures: [{ category: error.category, code: error.code, message: error.message }],
    });
  }

  private recordCloseFailure(
    error: ActorError,
    cause: unknown,
    memoizeFailure: boolean
  ): McpHostCloseReport {
    this.diagnose(error.code, cause);
    if (memoizeFailure) {
      this.fail(error);
    }
    return this.closeFailureReport(error);
  }

  private closeClient(memoizeFailure = true): Promise<McpHostCloseReport> {
    if (this.clientClosePromise) {
      return this.clientClosePromise;
    }
    const client = this.client;
    if (!client) {
      return Promise.resolve(freezeCloseReport(EMPTY_REPORT));
    }
    this.clientClosePromise = Promise.resolve().then(async () => {
      try {
        let rawReport: unknown;
        try {
          rawReport = await client.close();
        } catch (cause) {
          return this.recordCloseFailure(
            new ActorError('transport', 'mcp-client-close-failed'),
            cause,
            memoizeFailure
          );
        }
        let report: McpHostCloseReport;
        try {
          report = parseMcpHostCloseReport(rawReport);
        } catch (cause) {
          return this.recordCloseFailure(
            new ActorError('protocol', 'mcp-client-close-report-invalid'),
            cause,
            memoizeFailure
          );
        }
        if (report.failures.length > 0) {
          const error = new ActorError('transport', 'mcp-client-close-reported-failures');
          this.diagnose(error.code, report);
          if (memoizeFailure) {
            this.fail(error);
          }
          return freezeCloseReport({
            ...report,
            failures: [{ category: error.category, code: error.code, message: error.message }],
          });
        }
        return freezeCloseReport(report);
      } finally {
        this.client = undefined;
      }
    });
    return this.clientClosePromise;
  }
}
