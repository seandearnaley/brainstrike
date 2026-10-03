import { randomUUID } from 'node:crypto';
import type {
  McpClientHandlerContext,
  McpElicitationPresenter,
} from '@brainstrike/agent/mcp-client';
import {
  validateMcpElicitationRequest,
  validateMcpElicitationResult,
} from '@brainstrike/agent/mcp-client';
import type {
  ConfiguredMcpServerId,
  McpHostOperation,
  McpHostServerSnapshot,
  McpServerIdentity,
  McpTaskHandle,
} from '@brainstrike/assistant-contract';
import { McpTaskHandleSchema } from '@brainstrike/assistant-contract';
import type {
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/client';

const FINALIZED_OBSERVER_LIMIT = 4;
const FINALIZED_PRESENTATION_LIMIT = 128;
const OPERATION_TARGET_LIMIT = 1024;
const PENDING_PRESENTATION_LIMIT = 32;
const REQUEST_ID_LIMIT = 256;
const SERVER_IDENTITY_FIELD_LIMIT = 256;
export type McpElicitationPresenterErrorCode =
  | 'mcp-elicitation-already-settled'
  | 'mcp-elicitation-authority-retired'
  | 'mcp-elicitation-caller-aborted'
  | 'mcp-elicitation-origin-unbound'
  | 'mcp-elicitation-id-collision'
  | 'mcp-elicitation-pending-limit'
  | 'mcp-elicitation-presenter-closed'
  | 'mcp-elicitation-presenter-unavailable'
  | 'mcp-elicitation-request-invalid'
  | 'mcp-elicitation-settlement-invalid'
  | 'mcp-elicitation-stale-authority'
  | 'mcp-elicitation-url-not-authorized'
  | 'mcp-elicitation-url-sensitive';
const ERROR_MESSAGES = {
  'mcp-elicitation-already-settled': 'MCP elicitation was already settled',
  'mcp-elicitation-authority-retired': 'MCP elicitation authority was retired',
  'mcp-elicitation-caller-aborted': 'MCP elicitation caller aborted',
  'mcp-elicitation-id-collision': 'MCP elicitation presentation id collided',
  'mcp-elicitation-origin-unbound': 'MCP elicitation has no originating host operation',
  'mcp-elicitation-pending-limit': 'MCP elicitation pending limit was reached',
  'mcp-elicitation-presenter-closed': 'MCP elicitation presenter is closed',
  'mcp-elicitation-presenter-unavailable': 'MCP elicitation presenter is unavailable',
  'mcp-elicitation-request-invalid': 'MCP elicitation request is invalid',
  'mcp-elicitation-settlement-invalid': 'MCP elicitation settlement is invalid',
  'mcp-elicitation-stale-authority': 'MCP elicitation authority is stale',
  'mcp-elicitation-url-not-authorized': 'MCP elicitation URL was not authorized',
  'mcp-elicitation-url-sensitive': 'MCP elicitation URL contains sensitive parameters',
} satisfies Record<McpElicitationPresenterErrorCode, string>;
export class McpElicitationPresenterError extends Error {
  readonly category = 'operation' as const;
  constructor(readonly code: McpElicitationPresenterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'McpElicitationPresenterError';
  }
}
export interface McpElicitationOperationProjection {
  readonly target?: string;
  readonly type: McpHostOperation['type'];
}
export interface McpElicitationProvenance {
  readonly configuredProtocol: McpHostServerSnapshot['configuredProtocol'];
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  readonly invocationId: string;
  readonly negotiatedRevision: string;
  readonly operation: McpElicitationOperationProjection;
  readonly requestId: number | string;
  readonly serverIdentity?: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
    readonly websiteOrigin?: string;
  };
  readonly taskHandle?: McpTaskHandle;
  readonly transport: McpHostServerSnapshot['transport'];
}
export interface McpFormElicitationPresentation {
  readonly id: string;
  readonly message: string;
  readonly mode: 'form';
  readonly provenance: McpElicitationProvenance;
  readonly requestedSchema: ElicitRequestFormParams['requestedSchema'];
}
export interface McpUrlElicitationPresentation {
  readonly id: string;
  readonly message: string;
  readonly mode: 'url';
  readonly provenance: McpElicitationProvenance;
  readonly url: string;
}
export type McpElicitationPresentation =
  | McpFormElicitationPresentation
  | McpUrlElicitationPresentation;
interface PendingPresentation {
  readonly cleanup: () => void;
  readonly invocation: InvocationAuthority;
  readonly presentation: McpElicitationPresentation;
  readonly reject: (cause: McpElicitationPresenterError) => void;
  readonly request: ElicitRequest;
  readonly resolve: (result: ElicitResult) => void;
}
interface InvocationAuthority {
  binding?: {
    readonly configuredServerId: ConfiguredMcpServerId;
    readonly generation: number;
  };
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly id: string;
  readonly operation: McpElicitationOperationProjection;
  readonly taskHandle?: McpTaskHandle;
}
/**
 * Task-scoped elicitation origin (BST-1566). A durable MCP task raises
 * `input_required` outside any in-flight host operation, so its presenter is
 * bound explicitly to the task's server generation and the originating
 * `tools/call` projection instead of the single-matching-operation registry.
 */
export interface McpTaskElicitationBinding {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  readonly operation: McpElicitationOperationProjection;
  readonly taskHandle: McpTaskHandle;
}
export interface McpBoundTaskElicitationPresenter {
  readonly presenter: McpElicitationPresenter;
  /** Idempotent; later presentations through this binding fail closed. */
  release(): void;
}
export interface McpElicitationPresenterAuthorityOptions {
  readonly createPresentationId?: () => string;
  readonly openExternal: (url: URL) => Promise<void>;
  readonly resolveServer: (
    configuredServerId: ConfiguredMcpServerId
  ) => McpHostServerSnapshot | undefined;
}
type PresentationListener = (presentation: McpElicitationPresentation) => void;
export interface McpElicitationFinalizedEvent {
  readonly code: McpElicitationPresenterErrorCode;
  readonly id: string;
}
type FinalizedObserver = (event: McpElicitationFinalizedEvent) => void;
const SENSITIVE_URL_PARAMETER =
  /^(?:(?:access|authorization|id|refresh|session)[_.-]?token|api[_.-]?key|authorization|authorization[_.-]?code|client[_.-]?secret|code|code[_.-]?verifier|credential|password|secret|token)$/iu;
const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 12)}…[truncated]`;

function projectServerIdentity(
  identity: McpServerIdentity | undefined
): McpElicitationProvenance['serverIdentity'] {
  if (!identity) {
    return undefined;
  }
  const websiteOrigin =
    identity.websiteUrl && URL.canParse(identity.websiteUrl)
      ? new URL(identity.websiteUrl).origin
      : undefined;
  return {
    name: clip(identity.name, SERVER_IDENTITY_FIELD_LIMIT),
    ...(identity.title ? { title: clip(identity.title, SERVER_IDENTITY_FIELD_LIMIT) } : {}),
    version: clip(identity.version, SERVER_IDENTITY_FIELD_LIMIT),
    ...(websiteOrigin ? { websiteOrigin } : {}),
  };
}
function operationTarget(operation: McpHostOperation): string | undefined {
  switch (operation.type) {
    case 'tools/call':
      return operation.toolName;
    case 'prompts/get':
      return operation.name;
    case 'resources/read':
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      return operation.uri;
    case 'completion/complete':
      return operation.ref.type === 'ref/prompt' ? operation.ref.name : operation.ref.uri;
    default:
      return undefined;
  }
}
function projectOperation(operation: McpHostOperation): McpElicitationOperationProjection {
  const target = operationTarget(operation);
  return {
    ...(target ? { target: clip(target, OPERATION_TARGET_LIMIT) } : {}),
    type: operation.type,
  };
}
function validateRequestId(requestId: number | string): void {
  if (
    (typeof requestId === 'string' && requestId.length > REQUEST_ID_LIMIT) ||
    (typeof requestId === 'number' && !Number.isSafeInteger(requestId))
  ) {
    throw new McpElicitationPresenterError('mcp-elicitation-settlement-invalid');
  }
}
export class McpElicitationPresenterAuthority {
  private closed = false;
  private readonly createPresentationId: () => string;
  private readonly finalized = new Map<string, McpElicitationPresenterErrorCode>();
  private readonly finalizedObservers = new Set<FinalizedObserver>();
  private invocationSequence = 0;
  private readonly invocations = new Set<InvocationAuthority>();
  private listener: PresentationListener | undefined;
  private readonly pending = new Map<string, PendingPresentation>();
  private readonly processNonce = randomUUID();
  private readonly urlGrants = new WeakMap<InvocationAuthority, Map<number | string, string>>();
  readonly presenter: McpElicitationPresenter;

  constructor(private readonly options: McpElicitationPresenterAuthorityOptions) {
    this.createPresentationId = options.createPresentationId ?? randomUUID;
    this.presenter = {
      confirmUrl: (request, context) => this.present(request, context),
      form: true,
      openExternal: (url, context) => this.openUrl(url, context),
      presentForm: (request, context) => this.present(request, context),
      url: true,
    };
  }
  attach(listener: PresentationListener): () => void {
    if (this.closed) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-closed');
    }
    if (this.listener) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable');
    }
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
        this.finishAll('mcp-elicitation-presenter-unavailable');
      }
    };
  }

  /**
   * Observes every pending presentation finalization (settlement, abort,
   * retirement, detach, close) so a renderer surface can retire its dialog.
   * Bounded to a few observers; observer failures never affect settlement.
   */
  observeFinalized(observer: FinalizedObserver): () => void {
    if (this.closed) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-closed');
    }
    if (this.finalizedObservers.size >= FINALIZED_OBSERVER_LIMIT) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable');
    }
    this.finalizedObservers.add(observer);
    return () => {
      this.finalizedObservers.delete(observer);
    };
  }

  async runWithOperation<T>(operation: McpHostOperation, run: () => Promise<T>): Promise<T> {
    const authority = {
      configuredServerId: operation.configuredServerId,
      id: `${this.processNonce}:${++this.invocationSequence}`,
      operation: projectOperation(operation),
    } satisfies InvocationAuthority;
    this.invocations.add(authority);
    try {
      return await run();
    } finally {
      this.invocations.delete(authority);
      this.urlGrants.delete(authority);
    }
  }

  bindTaskPresenter(binding: McpTaskElicitationBinding): McpBoundTaskElicitationPresenter {
    if (this.closed) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-closed');
    }
    const taskHandle = McpTaskHandleSchema.parse(binding.taskHandle);
    if (taskHandle.serverId !== binding.configuredServerId) {
      throw new McpElicitationPresenterError('mcp-elicitation-stale-authority');
    }
    const authority: InvocationAuthority = {
      binding: { configuredServerId: binding.configuredServerId, generation: binding.generation },
      configuredServerId: binding.configuredServerId,
      id: `${this.processNonce}:task:${++this.invocationSequence}`,
      operation: { ...binding.operation },
      taskHandle,
    };
    let released = false;
    const resolve = (): InvocationAuthority => {
      if (released) {
        throw new McpElicitationPresenterError('mcp-elicitation-authority-retired');
      }
      return authority;
    };
    return {
      presenter: {
        confirmUrl: (request, context) => this.present(request, context, resolve),
        form: true,
        openExternal: (url, context) => this.openUrl(url, context, resolve),
        presentForm: (request, context) => this.present(request, context, resolve),
        url: true,
      },
      release: () => {
        released = true;
        this.urlGrants.delete(authority);
      },
    };
  }

  settle(input: {
    readonly action: ElicitResult['action'];
    readonly configuredServerId: ConfiguredMcpServerId;
    readonly content?: ElicitResult['content'];
    readonly generation: number;
    readonly id?: string;
    readonly requestId: number | string;
  }): void {
    if (!(input.id && typeof input.id === 'string')) {
      throw new McpElicitationPresenterError('mcp-elicitation-settlement-invalid');
    }
    const pending = this.pending.get(input.id);
    if (!pending) {
      throw new McpElicitationPresenterError(
        this.finalized.get(input.id) ?? 'mcp-elicitation-settlement-invalid'
      );
    }
    const { provenance } = pending.presentation;
    if (
      input.configuredServerId !== provenance.configuredServerId ||
      input.generation !== provenance.generation ||
      input.requestId !== provenance.requestId
    ) {
      throw new McpElicitationPresenterError('mcp-elicitation-stale-authority');
    }
    if (
      !(['accept', 'decline', 'cancel'] as const).includes(input.action) ||
      (input.action !== 'accept' && input.content !== undefined) ||
      (pending.presentation.mode === 'url' && input.content !== undefined) ||
      (pending.presentation.mode === 'form' &&
        input.action === 'accept' &&
        !(input.content && typeof input.content === 'object' && !Array.isArray(input.content)))
    ) {
      throw new McpElicitationPresenterError('mcp-elicitation-settlement-invalid');
    }
    let result: ElicitResult;
    try {
      result = {
        action: input.action,
        ...(input.action === 'accept' && input.content !== undefined
          ? { content: structuredClone(input.content) }
          : {}),
      };
      validateMcpElicitationResult(pending.request, result);
    } catch {
      throw new McpElicitationPresenterError('mcp-elicitation-settlement-invalid');
    }
    if (pending.presentation.mode === 'url' && input.action === 'accept') {
      const grants = this.urlGrants.get(pending.invocation) ?? new Map();
      grants.set(input.requestId, pending.presentation.url);
      this.urlGrants.set(pending.invocation, grants);
    }
    this.finish(input.id, 'mcp-elicitation-already-settled', () => pending.resolve(result));
  }

  retireServer(configuredServerId: ConfiguredMcpServerId, generation: number): void {
    for (const [id, pending] of this.pending) {
      const provenance = pending.presentation.provenance;
      if (
        provenance.configuredServerId === configuredServerId &&
        provenance.generation === generation
      ) {
        this.finish(id, 'mcp-elicitation-stale-authority', () =>
          pending.reject(new McpElicitationPresenterError('mcp-elicitation-authority-retired'))
        );
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listener = undefined;
    this.finishAll('mcp-elicitation-presenter-closed');
    this.finalizedObservers.clear();
  }

  private async present(
    request: ElicitRequest,
    context: McpClientHandlerContext,
    resolveInvocation: (context: McpClientHandlerContext) => InvocationAuthority = (
      handlerContext
    ) => this.resolveOperationInvocation(handlerContext)
  ): Promise<ElicitResult> {
    try {
      validateMcpElicitationRequest(request);
    } catch {
      return Promise.reject(new McpElicitationPresenterError('mcp-elicitation-request-invalid'));
    }
    const listener = this.listener;
    if (this.closed || !listener) {
      return Promise.reject(
        new McpElicitationPresenterError(
          this.closed ? 'mcp-elicitation-presenter-closed' : 'mcp-elicitation-presenter-unavailable'
        )
      );
    }
    let invocation: InvocationAuthority;
    let provenance: McpElicitationProvenance;
    try {
      ({ invocation, provenance } = this.resolveAuthority(context, resolveInvocation));
    } catch (cause) {
      return Promise.reject(cause);
    }
    const id = this.createPresentationId();
    const deferred = Promise.withResolvers<ElicitResult>();
    const params = request.params;
    let presentation: McpElicitationPresentation;
    if (params.mode === 'url') {
      if (!URL.canParse(params.url)) {
        return Promise.reject(new McpElicitationPresenterError('mcp-elicitation-request-invalid'));
      }
      const url = new URL(params.url);
      const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
      if (
        [...url.searchParams.keys(), ...fragment.keys()].some((key) =>
          SENSITIVE_URL_PARAMETER.test(key)
        )
      ) {
        return Promise.reject(new McpElicitationPresenterError('mcp-elicitation-url-sensitive'));
      }
      presentation = { id, message: params.message, mode: 'url', provenance, url: url.href };
    } else {
      presentation = {
        id,
        message: params.message,
        mode: 'form',
        provenance,
        requestedSchema: structuredClone(params.requestedSchema),
      };
    }
    this.publish(presentation, request, invocation, deferred, context.signal, listener);
    return deferred.promise;
  }

  private async openUrl(
    url: URL,
    context: McpClientHandlerContext,
    resolveInvocation: (context: McpClientHandlerContext) => InvocationAuthority = (
      handlerContext
    ) => this.resolveOperationInvocation(handlerContext)
  ): Promise<void> {
    if (this.closed) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-closed');
    }
    const { invocation } = this.resolveAuthority(context, resolveInvocation);
    const grants = this.urlGrants.get(invocation);
    if (context.signal.aborted) {
      grants?.delete(context.requestId);
      throw new McpElicitationPresenterError('mcp-elicitation-caller-aborted');
    }
    if (grants?.get(context.requestId) !== url.href) {
      throw new McpElicitationPresenterError('mcp-elicitation-url-not-authorized');
    }
    grants.delete(context.requestId);
    if (grants.size === 0) {
      this.urlGrants.delete(invocation);
    }
    await this.options.openExternal(url);
  }

  private publish(
    presentation: McpElicitationPresentation,
    request: ElicitRequest,
    invocation: InvocationAuthority,
    deferred: PromiseWithResolvers<ElicitResult>,
    signal: AbortSignal,
    listener: PresentationListener
  ): void {
    const onAbort = () => {
      const pending = this.pending.get(presentation.id);
      if (pending) {
        this.finish(presentation.id, 'mcp-elicitation-caller-aborted', () =>
          pending.reject(new McpElicitationPresenterError('mcp-elicitation-caller-aborted'))
        );
      }
    };
    if (signal.aborted) {
      deferred.reject(new McpElicitationPresenterError('mcp-elicitation-caller-aborted'));
      return;
    }
    if (this.pending.size >= PENDING_PRESENTATION_LIMIT) {
      deferred.reject(new McpElicitationPresenterError('mcp-elicitation-pending-limit'));
      return;
    }
    if (this.pending.has(presentation.id) || this.finalized.has(presentation.id)) {
      deferred.reject(new McpElicitationPresenterError('mcp-elicitation-id-collision'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    this.pending.set(presentation.id, {
      cleanup: () => signal.removeEventListener('abort', onAbort),
      invocation,
      presentation,
      reject: deferred.reject,
      request: structuredClone(request),
      resolve: deferred.resolve,
    });
    try {
      listener(structuredClone(presentation));
    } catch {
      this.finish(presentation.id, 'mcp-elicitation-presenter-unavailable', () =>
        deferred.reject(new McpElicitationPresenterError('mcp-elicitation-presenter-unavailable'))
      );
    }
  }

  private resolveOperationInvocation(context: McpClientHandlerContext): InvocationAuthority {
    const matches = [...this.invocations].filter(
      ({ configuredServerId }) => configuredServerId === context.serverName
    );
    const invocation = matches.length === 1 ? matches[0] : undefined;
    if (!invocation) {
      throw new McpElicitationPresenterError('mcp-elicitation-origin-unbound');
    }
    return invocation;
  }

  private resolveAuthority(
    context: McpClientHandlerContext,
    resolveInvocation: (context: McpClientHandlerContext) => InvocationAuthority
  ): {
    invocation: InvocationAuthority;
    provenance: McpElicitationProvenance;
  } {
    const invocation = resolveInvocation(context);
    validateRequestId(context.requestId);
    const server = this.options.resolveServer(invocation.configuredServerId);
    if (
      server?.state !== 'connected' ||
      server.configuredServerId !== invocation.configuredServerId ||
      (invocation.binding !== undefined &&
        (invocation.binding.configuredServerId !== server.configuredServerId ||
          invocation.binding.generation !== server.generation))
    ) {
      throw new McpElicitationPresenterError('mcp-elicitation-stale-authority');
    }
    const serverIdentity = projectServerIdentity(server.negotiated.serverIdentity);
    invocation.binding ??= {
      configuredServerId: server.configuredServerId,
      generation: server.generation,
    };
    return {
      invocation,
      provenance: {
        configuredProtocol: server.configuredProtocol,
        configuredServerId: server.configuredServerId,
        generation: server.generation,
        invocationId: invocation.id,
        negotiatedRevision: server.negotiated.revision,
        operation: { ...invocation.operation },
        requestId: context.requestId,
        ...(invocation.taskHandle ? { taskHandle: { ...invocation.taskHandle } } : {}),
        ...(serverIdentity ? { serverIdentity } : {}),
        transport: server.transport,
      },
    };
  }

  private finish(
    id: string,
    finalCode: McpElicitationPresenterErrorCode,
    settle: () => void
  ): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    pending.cleanup();
    this.recordFinalized(id, finalCode);
    settle();
    for (const observer of this.finalizedObservers) {
      try {
        observer({ code: finalCode, id });
      } catch {
        // Observers are diagnostics-only; a failing observer never alters settlement.
      }
    }
  }

  private finishAll(code: McpElicitationPresenterErrorCode): void {
    for (const [id, pending] of this.pending) {
      this.finish(id, code, () => pending.reject(new McpElicitationPresenterError(code)));
    }
  }

  private recordFinalized(id: string, code: McpElicitationPresenterErrorCode): void {
    this.finalized.set(id, code);
    while (this.finalized.size > FINALIZED_PRESENTATION_LIMIT) {
      const oldest = this.finalized.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.finalized.delete(oldest);
    }
  }
}
