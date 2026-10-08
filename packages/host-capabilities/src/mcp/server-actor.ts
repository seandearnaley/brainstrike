import type {
  ConfiguredMcpServerId,
  McpExtensionEnablement,
  McpHostAuthSnapshot,
  McpHostCatalog,
  McpHostCloseReport,
  McpHostDiagnostic,
  McpHostError,
  McpHostInvokeOptions,
  McpHostOperation,
  McpHostOperationResult,
  McpHostServerSnapshot,
  McpNegotiatedStatus,
  McpStableErrorCategory,
} from '@brainstrike/assistant-contract';
import { MCP_HOST_DIAGNOSTIC_MAX_ENTRIES } from '@brainstrike/assistant-contract';
import {
  parseMcpHostCatalog,
  parseMcpHostCloseReport,
  parseMcpHostOperationResult,
  parseMcpNegotiatedStatus,
} from '@brainstrike/assistant-contract/mcp-host-runtime';
import { OAuthError, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { findBearerCredentialFailure, McpLifecycleFailure } from './lifecycle-errors.js';

type McpServerActorInvokeOptions = McpHostInvokeOptions & { signal: AbortSignal };
export interface McpServerActorClient {
  catalog?(): McpHostCatalog;
  close(): McpHostCloseReport | Promise<McpHostCloseReport>;
  invoke(operation: McpHostOperation, options: McpServerActorInvokeOptions): Promise<unknown>;
  readonly negotiated: McpNegotiatedStatus;
  watchCatalog?(listener: (catalog: McpHostCatalog) => void): () => void;
}
export class McpServerActorClientCleanupError extends AggregateError {
  override readonly name = 'McpServerActorClientCleanupError';
}
interface ClientContext {
  configuredServerId: ConfiguredMcpServerId;
  generation: number;
  /** Only an explicit host Connect/Retry/Reauthorize control may allow browser authorization. */
  interactiveAuthorization?: boolean;
  onDiagnostic(diagnostic: McpHostDiagnostic): void;
  onUnexpectedClose(failure?: McpLifecycleFailure): void;
  signal: AbortSignal;
}
export type McpServerActorClientFactory = (
  context: ClientContext
) => McpServerActorClient | Promise<McpServerActorClient>;
interface McpServerActorOptions extends Pick<ClientContext, 'configuredServerId' | 'generation'> {
  auth?: () => McpHostAuthSnapshot;
  clearCredentials?: () => Promise<void>;
  configuredProtocol: '2026-07-28' | 'auto' | 'legacy';
  enabledTools?: readonly string[];
  /** Effective registered-extension state for this generation (BST-1604). */
  extensions?: McpExtensionEnablement;
  factory: McpServerActorClientFactory;
  onAuthorityRetired?(): void;
  /**
   * Main-process-only diagnostic sink. The cause is RAW and UNSANITIZED and may
   * contain auth headers, tokens in URLs, or stdio argv. Never forward it to a
   * renderer or persist it without the platform redaction path.
   */
  onInternalError(code: McpServerActorDiagnosticCode, cause: unknown): void;
  onSnapshotChanged?(snapshot: McpHostServerSnapshot): void;
  startup: 'automatic' | 'authentication-required';
  transport: 'sse' | 'stdio' | 'streamable-http';
}
type ActorStatus =
  | {
      state: 'authentication-required' | 'authorizing' | 'closing' | 'connecting' | 'disconnected';
    }
  | { error: McpHostError; state: 'error' }
  | { catalog?: McpHostCatalog; negotiated: McpNegotiatedStatus; state: 'connected' };
type McpServerActorErrorCode =
  | 'mcp-authentication-required'
  | 'mcp-bearer-authorization-conflict'
  | 'mcp-bearer-credential-malformed'
  | 'mcp-bearer-credential-missing'
  | 'mcp-bearer-credential-unreadable'
  | 'mcp-bearer-origin-mismatch'
  | 'mcp-client-close-failed'
  | 'mcp-client-close-report-invalid'
  | 'mcp-client-close-reported-failures'
  | 'mcp-client-creation-cleanup-failed'
  | 'mcp-client-creation-failed'
  | 'mcp-credential-clear-failed'
  | 'mcp-auth-callback-timeout'
  | 'mcp-browser-open-failed'
  | 'mcp-child-exited'
  | 'mcp-connection-failed'
  | 'mcp-package-resolution-failed'
  | 'mcp-protocol-timeout'
  | 'mcp-server-rejected'
  | 'mcp-spawn-not-found'
  | 'mcp-catalog-invalid'
  | 'mcp-configured-server-mismatch'
  // Stable BST-1504 cross-process code; the underscore spelling is intentional.
  | 'mcp_generation_retired'
  | 'mcp-authentication-failed'
  | 'mcp-authorization-denied'
  | 'mcp-capability-missing'
  | 'mcp-header-mismatch'
  | 'mcp-era-mismatch'
  | 'mcp-era-negotiation-failed'
  | 'mcp-input-rounds-exhausted'
  | 'mcp-invalid-result'
  | 'mcp-invalid-params'
  | 'mcp-list-pagination-exceeded'
  | 'mcp-oauth-flow-failed'
  | 'mcp-protocol-error'
  | 'mcp-request-timeout'
  | 'mcp-result-type-unsupported'
  | 'mcp-sdk-error'
  | 'mcp-sdk-http-failed'
  | 'mcp-session-termination-failed'
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
    super(
      code === 'mcp-authentication-required'
        ? 'MCP authentication required. Connect or reauthorize this server in Settings > AI Tools.'
        : 'MCP server actor operation failed'
    );
    this.name = 'McpServerActorError';
  }
}

const MCP_HEADER_MISMATCH_CODE = -32_020;

/**
 * Consecutive unanswered `mcp-request-timeout`s before the transport is
 * presumed wedged (BST-1594).
 *
 * Two, not one: the FIRST timeout is what a merely slow server produces, and
 * retiring on it is the bug this actor was fixed for. Two in a row with no
 * intervening answer of ANY kind is no longer explicable by slowness — nothing
 * else here probes liveness, so the counter is the liveness probe.
 */
const MCP_WEDGED_TRANSPORT_TIMEOUTS = 2;

interface MappedMcpOperationError {
  category: McpStableErrorCategory;
  code: McpServerActorErrorCode;
}

function mapMcpOperationError(error: unknown): MappedMcpOperationError {
  const bearerFailure = findBearerCredentialFailure(error);
  if (bearerFailure) {
    return { category: bearerFailure.category, code: bearerFailure.code };
  }
  if (OAuthError.isInstance(error)) {
    return { category: 'authentication', code: 'mcp-oauth-flow-failed' };
  }
  if (ProtocolError.isInstance(error)) {
    switch (error.code) {
      case MCP_HEADER_MISMATCH_CODE:
        return { category: 'protocol', code: 'mcp-header-mismatch' };
      case -32_021:
        return { category: 'protocol', code: 'mcp-capability-missing' };
      case -32_022:
        return { category: 'protocol', code: 'mcp-era-mismatch' };
      case -32_602:
        return { category: 'protocol', code: 'mcp-invalid-params' };
      default:
        return { category: 'protocol', code: 'mcp-protocol-error' };
    }
  }
  if (SdkError.isInstance(error)) {
    switch (error.code) {
      case SdkErrorCode.ClientHttpAuthentication:
        return { category: 'authentication', code: 'mcp-authentication-failed' };
      case SdkErrorCode.ClientHttpForbidden:
        return { category: 'authorization', code: 'mcp-authorization-denied' };
      case SdkErrorCode.ClientHttpFailedToTerminateSession:
        return { category: 'transport', code: 'mcp-session-termination-failed' };
      case SdkErrorCode.EraNegotiationFailed:
        return { category: 'protocol', code: 'mcp-era-negotiation-failed' };
      case SdkErrorCode.InputRequiredRoundsExceeded:
        return { category: 'operation', code: 'mcp-input-rounds-exhausted' };
      case SdkErrorCode.InvalidResult:
        return { category: 'protocol', code: 'mcp-invalid-result' };
      case SdkErrorCode.ListPaginationExceeded:
        return { category: 'operation', code: 'mcp-list-pagination-exceeded' };
      case SdkErrorCode.CapabilityNotSupported:
        return { category: 'protocol', code: 'mcp-capability-missing' };
      case SdkErrorCode.MethodNotSupportedByProtocolVersion:
        return { category: 'protocol', code: 'mcp-era-mismatch' };
      case SdkErrorCode.RequestTimeout:
        return { category: 'operation', code: 'mcp-request-timeout' };
      case SdkErrorCode.UnsupportedResultType:
        return { category: 'protocol', code: 'mcp-result-type-unsupported' };
      case SdkErrorCode.ConnectionClosed:
        return { category: 'connection', code: 'mcp-transport-closed' };
      case SdkErrorCode.ClientHttpFailedToOpenStream:
      case SdkErrorCode.ClientHttpNotImplemented:
      case SdkErrorCode.ClientHttpUnexpectedContent:
      case SdkErrorCode.SendFailed:
      case SdkErrorCode.NotConnected:
        return { category: 'transport', code: 'mcp-sdk-http-failed' };
      default:
        return { category: 'transport', code: 'mcp-sdk-error' };
    }
  }
  return { category: 'transport', code: 'mcp-transport-operation-failed' };
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
export function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([work, aborted.promise]).finally(() =>
    signal.removeEventListener('abort', onAbort)
  );
}
export class McpServerActor {
  private readonly generationAbort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly diagnostics: McpHostDiagnostic[] = [];
  private readonly retiredError = new ActorError('generation-retired', 'mcp_generation_retired');
  private client: McpServerActorClient | undefined;
  private clientClosePromise: Promise<McpHostCloseReport> | undefined;
  private connectAttempt: AbortController | undefined;
  private connectAttemptInteractive = false;
  private connectRequestAbort = new AbortController();
  private clientPromise: Promise<McpServerActorClient> | undefined;
  private catalogUnsubscribe: (() => void) | undefined;
  private closePromise: Promise<McpHostCloseReport> | undefined;
  private diagnosticPublishQueued = false;
  private failure: ActorError | undefined;
  private transportInvalidated = false;
  private consecutiveRequestTimeouts = 0;
  private status: ActorStatus;
  constructor(private readonly options: McpServerActorOptions) {
    const auth = options.auth?.();
    const hasStoredOAuthCredentials =
      auth?.type === 'oauth-user' && auth.credentialState === 'stored';
    this.status = {
      state:
        options.startup === 'authentication-required' && !hasStoredOAuthCredentials
          ? 'authentication-required'
          : 'disconnected',
    };
  }
  connect(): Promise<McpHostServerSnapshot> {
    if (this.closePromise || this.generationAbort.signal.aborted || this.transportInvalidated) {
      return Promise.reject(this.retiredError);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    // A Connect can span background and interactive transport attempts. Its
    // cancellation lifetime belongs to the control request, not the first attempt.
    const signal = AbortSignal.any([this.generationAbort.signal, this.connectRequestAbort.signal]);
    const client = this.getClient(true);
    const work = client.then(() => this.snapshot());
    this.inFlight.add(work);
    const remove = () => this.inFlight.delete(work);
    work.then(remove, remove);
    return settleOnAbort(work, signal);
  }
  cancel(): Promise<McpHostServerSnapshot> {
    if (this.closePromise || this.generationAbort.signal.aborted || this.transportInvalidated) {
      return Promise.reject(this.retiredError);
    }

    this.connectRequestAbort.abort(new DOMException('MCP connection cancelled', 'AbortError'));
    this.connectRequestAbort = new AbortController();
    const attempt = this.connectAttempt;
    if (attempt && !attempt.signal.aborted) {
      attempt.abort(new DOMException('MCP connection cancelled', 'AbortError'));
    }
    const close = this.client ? this.closeClient(false) : Promise.resolve(EMPTY_REPORT);
    this.clientPromise = undefined;
    this.connectAttempt = undefined;
    const nextState =
      this.options.startup === 'authentication-required'
        ? 'authentication-required'
        : 'disconnected';
    return close.then(() => {
      this.clientClosePromise = undefined;
      this.change({ state: nextState });
      return this.snapshot();
    });
  }
  async disconnect(): Promise<McpHostServerSnapshot> {
    if (this.closePromise || this.generationAbort.signal.aborted || this.transportInvalidated) {
      throw this.retiredError;
    }

    this.connectRequestAbort.abort(new DOMException('MCP connection disconnected', 'AbortError'));
    this.connectRequestAbort = new AbortController();
    const attempt = this.connectAttempt;
    if (attempt && !attempt.signal.aborted) {
      attempt.abort(new DOMException('MCP connection disconnected', 'AbortError'));
    }
    const pendingClient = this.clientPromise;
    if (pendingClient) {
      await Promise.allSettled([pendingClient]);
    }
    const report = await this.closeClient(false);
    if (report.failures.length > 0) {
      throw this.fail(new ActorError('transport', 'mcp-client-close-reported-failures'));
    }
    try {
      await this.options.clearCredentials?.();
    } catch (cause) {
      const error = new ActorError('authentication', 'mcp-credential-clear-failed');
      this.diagnose(error.code, cause);
      throw this.fail(error);
    }
    this.change({
      state:
        this.options.startup === 'authentication-required'
          ? 'authentication-required'
          : 'disconnected',
    });
    return this.snapshot();
  }
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
    if (this.status.state === 'authentication-required') {
      return Promise.reject(new ActorError('authentication', 'mcp-authentication-required'));
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
    const work = Promise.resolve().then(() =>
      this.runAccepted(operation, signal, options?.signal, options)
    );
    const lease = settleOnAbort(work, signal);
    this.inFlight.add(work);
    const remove = () => this.inFlight.delete(work);
    work.then(remove, remove);
    return lease;
  }
  snapshot(): McpHostServerSnapshot {
    return structuredClone({
      ...(this.options.auth ? { auth: this.options.auth() } : {}),
      configuredProtocol: this.options.configuredProtocol,
      configuredServerId: this.options.configuredServerId,
      ...(this.options.enabledTools ? { enabledTools: this.options.enabledTools } : {}),
      ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      ...(this.diagnostics.length > 0 ? { diagnostics: this.diagnostics } : {}),
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
      this.options.onAuthorityRetired?.();
      this.change({
        error: { category: error.category, code: error.code, message: error.message },
        state: 'error',
      });
    }
    return this.failure;
  }
  private getClient(interactiveAuthorization = false): Promise<McpServerActorClient> {
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (this.clientPromise) {
      if (interactiveAuthorization && !this.connectAttemptInteractive) {
        // Reuse a successful refresh. Only an explicit Connect may continue a
        // completed background auth failure with a fresh interactive provider.
        // Cancellation, transport faults, and cleanup failures must not retry.
        const requestSignal = this.connectRequestAbort.signal;
        // createClientForAttempt clears the failed promise before publishing
        // authentication-required; ordinary requests still receive that failure.
        return this.clientPromise.catch((cause: unknown) => {
          if (!(cause instanceof ActorError) || cause.code !== 'mcp-authentication-required') {
            throw cause;
          }
          this.throwIfAborted(requestSignal);
          if (this.failure) {
            throw this.failure;
          }
          return this.getClient(true);
        });
      }
      return this.clientPromise;
    }
    const attempt = new AbortController();
    this.connectAttempt = attempt;
    this.connectAttemptInteractive = interactiveAuthorization;
    const clientPromise = Promise.resolve().then(() =>
      this.createClient(attempt, interactiveAuthorization)
    );
    this.clientPromise = clientPromise;
    void clientPromise.then(
      () => {
        if (this.clientPromise === clientPromise) {
          this.clientPromise = undefined;
          this.connectAttempt = undefined;
        }
      },
      () => {
        if (this.clientPromise === clientPromise) {
          this.clientPromise = undefined;
          this.connectAttempt = undefined;
        }
      }
    );
    this.change({
      state:
        this.options.startup === 'authentication-required' && interactiveAuthorization
          ? 'authorizing'
          : 'connecting',
    });
    return this.clientPromise;
  }
  private async createClient(
    attempt: AbortController,
    interactiveAuthorization: boolean
  ): Promise<McpServerActorClient> {
    const client = await this.createClientForAttempt(attempt, interactiveAuthorization);
    try {
      this.throwIfAborted(attempt.signal);
    } catch (cause) {
      if (this.generationAbort.signal.aborted) {
        this.client = client;
        throw cause;
      }
      await Promise.resolve(client.close()).catch(() => undefined);
      this.restorePreConnectState(attempt);
      throw cause;
    }
    if (this.connectAttempt !== attempt) {
      await Promise.resolve(client.close()).catch(() => undefined);
      throw attempt.signal.reason;
    }
    this.client = client;
    let status: McpNegotiatedStatus;
    try {
      status = parseMcpNegotiatedStatus(client.negotiated);
    } catch (cause) {
      this.throwIfAborted(attempt.signal);
      const cleanupReport = await this.closeClient(false);
      const cleanupFailed = cleanupReport.failures.length > 0;
      const error = new ActorError(
        'protocol',
        cleanupFailed ? 'mcp-negotiated-status-cleanup-failed' : 'mcp-negotiated-status-invalid'
      );
      this.diagnose(error.code, cause);
      throw this.fail(error);
    }
    if (this.failure) {
      // The transport was invalidated while the handshake was still running —
      // a stdio child that exits mid-`initialize` reaches `onUnexpectedClose`
      // before the client factory returns (BST-1600). `change` is an
      // unconditional single writer, so publishing `connected` here would
      // clobber that lifecycle failure and leave a dead server behind a
      // healthy row. The client is already owned by `this.client`, so actor
      // close still reaps it.
      throw this.failure;
    }
    if (!this.closePromise) {
      let catalog: McpHostCatalog | undefined;
      try {
        catalog = client.catalog ? parseMcpHostCatalog(client.catalog()) : undefined;
        this.catalogUnsubscribe = client.watchCatalog?.((nextCatalog) => {
          try {
            const parsed = parseMcpHostCatalog(nextCatalog);
            if (!this.closePromise && this.status.state === 'connected') {
              this.change({ catalog: parsed, negotiated: status, state: 'connected' });
            }
          } catch (cause) {
            this.diagnose('mcp-catalog-invalid', cause);
            this.fail(new ActorError('protocol', 'mcp-catalog-invalid'));
          }
        });
      } catch (cause) {
        const error = new ActorError('protocol', 'mcp-catalog-invalid');
        this.diagnose(error.code, cause);
        throw this.fail(error);
      }
      this.change({ ...(catalog ? { catalog } : {}), negotiated: status, state: 'connected' });
    }
    return client;
  }
  private async createClientForAttempt(
    attempt: AbortController,
    interactiveAuthorization: boolean
  ): Promise<McpServerActorClient> {
    try {
      return await this.options.factory({
        configuredServerId: this.options.configuredServerId,
        generation: this.options.generation,
        interactiveAuthorization,
        onDiagnostic: (diagnostic) => this.recordDiagnostic(diagnostic),
        onUnexpectedClose: (failure) => this.invalidateTransport(failure),
        signal: AbortSignal.any([this.generationAbort.signal, attempt.signal]),
      });
    } catch (cause) {
      const error =
        cause instanceof McpLifecycleFailure
          ? new ActorError(cause.category, cause.code)
          : new ActorError('connection', 'mcp-client-creation-failed');
      const cleanupFailed = cause instanceof McpServerActorClientCleanupError;
      if (cleanupFailed) {
        this.clientClosePromise = Promise.resolve(
          this.closeFailureReport(new ActorError('transport', 'mcp-client-creation-cleanup-failed'))
        );
        this.diagnose(error.code, cause);
      }
      if (attempt.signal.aborted) {
        this.restorePreConnectState(attempt);
        throw attempt.signal.reason;
      }
      this.throwIfAborted();
      if (!cleanupFailed) {
        this.diagnose(error.code, cause);
      }
      if (error.code === 'mcp-authentication-required') {
        if (this.connectAttempt === attempt) {
          this.clientPromise = undefined;
          this.connectAttempt = undefined;
        }
        this.change({ state: 'authentication-required' });
        throw error;
      }
      throw this.fail(error);
    }
  }
  private async runAccepted(
    operation: McpHostOperation,
    signal: AbortSignal,
    callerSignal?: AbortSignal,
    hostOptions?: McpHostInvokeOptions
  ): Promise<McpHostOperationResult> {
    const client = await this.getClient();
    this.throwIfAborted(callerSignal);
    if (this.failure) {
      throw this.failure;
    }
    let result: unknown;
    try {
      result = await client.invoke(operation, { ...hostOptions, signal });
    } catch (cause) {
      this.throwIfAborted(callerSignal);
      const mapped = mapMcpOperationError(cause);
      const error = new ActorError(mapped.category, mapped.code);
      this.diagnose(error.code, cause);
      this.chargeOperationFailure(mapped, error);
      throw error;
    }
    // An answer of any kind is the only liveness evidence this actor gets.
    this.consecutiveRequestTimeouts = 0;
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
  /**
   * Decide what ONE failed operation costs the generation.
   *
   * An `operation` failure normally belongs to THIS call, not to the
   * connection: an exhausted input round or a pagination cap only happens
   * because the server ANSWERED, repeatedly. Retiring the generation on those
   * turned one slow tool call into a server the user later found disconnected
   * (BST-1594), so they cost the generation nothing and reset the counter.
   *
   * `mcp-request-timeout` is the one operation code that is AMBIGUOUS: the SDK
   * gave up without an answer, which is what a merely slow server AND a wedged
   * stdio child or black-holed HTTP endpoint both look like. Nothing else in
   * this actor probes liveness — `onUnexpectedClose` fires only when the
   * transport actually CLOSES, and there is no ping or health probe — so
   * forgiving it forever would leave a genuinely dead server permanently and
   * silently `connected`, with every later call paying the full inactivity and
   * absolute budget. {@link MCP_WEDGED_TRANSPORT_TIMEOUTS} consecutive
   * unanswered timeouts therefore INVALIDATE the transport, which is precisely
   * the state `McpHostService.invoke` self-heals by building a fresh
   * generation on the next call — a path back, not a dead end.
   *
   * A caller-side cancellation (the agent's per-tool execution guard) never
   * reaches here: `throwIfAborted(callerSignal)` above rejects first. Only the
   * SDK's own request bounds feed this counter.
   */
  private chargeOperationFailure(mapped: MappedMcpOperationError, error: ActorError): void {
    if (mapped.category !== 'operation') {
      this.fail(error);
      return;
    }
    if (mapped.code !== 'mcp-request-timeout') {
      this.consecutiveRequestTimeouts = 0;
      return;
    }
    this.consecutiveRequestTimeouts += 1;
    if (this.consecutiveRequestTimeouts >= MCP_WEDGED_TRANSPORT_TIMEOUTS) {
      this.retireTransport(error);
    }
  }
  private invalidateTransport(failure?: McpLifecycleFailure): void {
    this.retireTransport(
      failure
        ? new ActorError(failure.category, failure.code)
        : new ActorError('connection', 'mcp-transport-closed')
    );
  }
  private retireTransport(error: ActorError): void {
    if (this.closePromise || this.transportInvalidated) {
      return;
    }
    this.transportInvalidated = true;
    this.fail(error);
  }
  private recordDiagnostic(diagnostic: McpHostDiagnostic): void {
    this.diagnostics.push(structuredClone(diagnostic));
    if (this.diagnostics.length > MCP_HOST_DIAGNOSTIC_MAX_ENTRIES) {
      this.diagnostics.splice(0, this.diagnostics.length - MCP_HOST_DIAGNOSTIC_MAX_ENTRIES);
    }
    if (this.diagnosticPublishQueued) {
      return;
    }
    this.diagnosticPublishQueued = true;
    queueMicrotask(() => {
      this.diagnosticPublishQueued = false;
      if (!this.closePromise) {
        this.change(this.status);
      }
    });
  }
  private retireGeneration(): void {
    if (!this.generationAbort.signal.aborted) {
      this.options.onAuthorityRetired?.();
      this.generationAbort.abort(this.retiredError);
    }
  }
  private throwIfAborted(callerSignal?: AbortSignal): void {
    if (this.generationAbort.signal.aborted) {
      throw this.retiredError;
    }
    callerSignal?.throwIfAborted();
  }
  private restorePreConnectState(attempt: AbortController): void {
    if (this.connectAttempt !== attempt) {
      return;
    }
    this.clientPromise = undefined;
    this.connectAttempt = undefined;
    this.change({
      state:
        this.options.startup === 'authentication-required'
          ? 'authentication-required'
          : 'disconnected',
    });
  }
  private async closeAfterDrain(): Promise<McpHostCloseReport> {
    await Promise.allSettled([...this.inFlight]);
    const report = await this.closeClient();
    if (!this.failure) {
      this.change({ state: 'disconnected' });
    }
    return freezeCloseReport(report);
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
        this.catalogUnsubscribe?.();
        this.catalogUnsubscribe = undefined;
        this.client = undefined;
      }
    });
    return this.clientClosePromise;
  }
}
