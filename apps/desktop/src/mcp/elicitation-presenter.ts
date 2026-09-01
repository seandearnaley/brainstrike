import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  McpClientHandlerContext,
  McpElicitationPresenter,
} from '@brainstrike/agent/mcp-client';
import type {
  ConfiguredMcpServerId,
  McpHostOperation,
  McpHostServerSnapshot,
  McpServerIdentity,
} from '@brainstrike/assistant-contract';
import type {
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/client';

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
  | 'mcp-elicitation-presenter-closed'
  | 'mcp-elicitation-presenter-unavailable'
  | 'mcp-elicitation-settlement-invalid'
  | 'mcp-elicitation-stale-authority'
  | 'mcp-elicitation-url-not-authorized'
  | 'mcp-elicitation-url-sensitive';

const ERROR_MESSAGES = {
  'mcp-elicitation-already-settled': 'MCP elicitation was already settled',
  'mcp-elicitation-authority-retired': 'MCP elicitation authority was retired',
  'mcp-elicitation-caller-aborted': 'MCP elicitation caller aborted',
  'mcp-elicitation-origin-unbound': 'MCP elicitation has no originating host operation',
  'mcp-elicitation-presenter-closed': 'MCP elicitation presenter is closed',
  'mcp-elicitation-presenter-unavailable': 'MCP elicitation presenter is unavailable',
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
  readonly negotiatedRevision: string;
  readonly operation: McpElicitationOperationProjection;
  readonly requestId: number | string;
  readonly serverIdentity?: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
    readonly websiteOrigin?: string;
  };
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
  readonly presentation: McpElicitationPresentation;
  readonly reject: (cause: McpElicitationPresenterError) => void;
  readonly resolve: (result: ElicitResult) => void;
}

interface UrlGrant {
  readonly url: string;
}

export interface McpElicitationPresenterAuthorityOptions {
  readonly createPresentationId?: () => string;
  readonly openExternal: (url: URL) => Promise<void>;
  readonly resolveServer: (
    configuredServerId: ConfiguredMcpServerId
  ) => McpHostServerSnapshot | undefined;
}

type PresentationListener = (presentation: McpElicitationPresentation) => void;
const SENSITIVE_URL_PARAMETER =
  /^(?:access_token|authorization|authorization_code|code|code_verifier|credential|id_token|password|refresh_token|secret|token)$/iu;

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 12)}…[truncated]`;

function projectServerIdentity(
  identity: McpServerIdentity | undefined
): McpElicitationProvenance['serverIdentity'] {
  if (!identity) {
    return undefined;
  }
  const websiteOrigin = identity.websiteUrl ? new URL(identity.websiteUrl).origin : undefined;
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
  private listener: PresentationListener | undefined;
  private readonly operation = new AsyncLocalStorage<McpHostOperation>();
  private readonly pending = new Map<string, PendingPresentation>();
  private readonly urlGrants = new Map<string, UrlGrant>();
  readonly presenter: McpElicitationPresenter;

  constructor(private readonly options: McpElicitationPresenterAuthorityOptions) {
    this.createPresentationId = options.createPresentationId ?? randomUUID;
    this.presenter = {
      confirmUrl: (request, context) => this.presentUrl(request.params, context),
      form: true,
      openExternal: (url, context) => this.openUrl(url, context),
      presentForm: (request, context) => this.presentForm(request.params, context),
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

  runWithOperation<T>(operation: McpHostOperation, run: () => T): T {
    return this.operation.run(operation, run);
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
    if (pending.presentation.mode === 'url' && input.action === 'accept') {
      this.urlGrants.set(this.grantKey(pending.presentation.provenance), {
        url: pending.presentation.url,
      });
    }
    const result = {
      action: input.action,
      ...(input.action === 'accept' && input.content !== undefined
        ? { content: structuredClone(input.content) }
        : {}),
    } satisfies ElicitResult;
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
    for (const [key] of this.urlGrants) {
      if (key.startsWith(`${configuredServerId}\u0000${generation}\u0000`)) {
        this.urlGrants.delete(key);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listener = undefined;
    this.urlGrants.clear();
    this.finishAll('mcp-elicitation-presenter-closed');
  }

  private presentForm(
    params: ElicitRequestFormParams,
    context: McpClientHandlerContext
  ): Promise<ElicitResult> {
    const listener = this.listener;
    if (this.closed || !listener) {
      return Promise.reject(
        new McpElicitationPresenterError(
          this.closed ? 'mcp-elicitation-presenter-closed' : 'mcp-elicitation-presenter-unavailable'
        )
      );
    }
    const provenance = this.resolveProvenance(context);
    const id = this.createPresentationId();
    const deferred = Promise.withResolvers<ElicitResult>();
    const presentation = {
      id,
      message: params.message,
      mode: 'form',
      provenance,
      requestedSchema: structuredClone(params.requestedSchema),
    } satisfies McpFormElicitationPresentation;
    this.publish(presentation, deferred, context.signal, listener);
    return deferred.promise;
  }

  private presentUrl(
    params: ElicitRequestURLParams,
    context: McpClientHandlerContext
  ): Promise<Pick<ElicitResult, 'action'>> {
    const url = new URL(params.url);
    const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    if (
      [...url.searchParams.keys(), ...fragment.keys()].some((key) =>
        SENSITIVE_URL_PARAMETER.test(key)
      )
    ) {
      return Promise.reject(new McpElicitationPresenterError('mcp-elicitation-url-sensitive'));
    }
    const listener = this.listener;
    if (this.closed || !listener) {
      return Promise.reject(
        new McpElicitationPresenterError(
          this.closed ? 'mcp-elicitation-presenter-closed' : 'mcp-elicitation-presenter-unavailable'
        )
      );
    }
    const deferred = Promise.withResolvers<ElicitResult>();
    const presentation = {
      id: this.createPresentationId(),
      message: params.message,
      mode: 'url',
      provenance: this.resolveProvenance(context),
      url: url.href,
    } satisfies McpUrlElicitationPresentation;
    this.publish(presentation, deferred, context.signal, listener);
    return deferred.promise;
  }

  private async openUrl(url: URL, context: McpClientHandlerContext): Promise<void> {
    if (this.closed) {
      throw new McpElicitationPresenterError('mcp-elicitation-presenter-closed');
    }
    const provenance = this.resolveProvenance(context);
    const key = this.grantKey(provenance);
    if (context.signal.aborted) {
      this.urlGrants.delete(key);
      throw new McpElicitationPresenterError('mcp-elicitation-caller-aborted');
    }
    const grant = this.urlGrants.get(key);
    if (grant?.url !== url.href) {
      throw new McpElicitationPresenterError('mcp-elicitation-url-not-authorized');
    }
    this.urlGrants.delete(key);
    await this.options.openExternal(url);
  }

  private publish(
    presentation: McpElicitationPresentation,
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
    if (
      this.pending.size >= PENDING_PRESENTATION_LIMIT ||
      this.pending.has(presentation.id) ||
      this.finalized.has(presentation.id)
    ) {
      deferred.reject(new McpElicitationPresenterError('mcp-elicitation-settlement-invalid'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    this.pending.set(presentation.id, {
      cleanup: () => signal.removeEventListener('abort', onAbort),
      presentation,
      reject: deferred.reject,
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

  private resolveProvenance(context: McpClientHandlerContext): McpElicitationProvenance {
    const operation = this.operation.getStore();
    if (!operation || operation.configuredServerId !== context.serverName) {
      throw new McpElicitationPresenterError('mcp-elicitation-origin-unbound');
    }
    validateRequestId(context.requestId);
    const server = this.options.resolveServer(operation.configuredServerId);
    if (
      server?.state !== 'connected' ||
      server.configuredServerId !== operation.configuredServerId
    ) {
      throw new McpElicitationPresenterError('mcp-elicitation-stale-authority');
    }
    const serverIdentity = projectServerIdentity(server.negotiated.serverIdentity);
    return {
      configuredProtocol: server.configuredProtocol,
      configuredServerId: server.configuredServerId,
      generation: server.generation,
      negotiatedRevision: server.negotiated.revision,
      operation: projectOperation(operation),
      requestId: context.requestId,
      ...(serverIdentity ? { serverIdentity } : {}),
      transport: server.transport,
    };
  }

  private grantKey(provenance: McpElicitationProvenance): string {
    return `${provenance.configuredServerId}\u0000${provenance.generation}\u0000${typeof provenance.requestId}:${String(provenance.requestId)}`;
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
