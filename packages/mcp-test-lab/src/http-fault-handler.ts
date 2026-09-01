import type { McpHandlerRequestOptions, McpHttpHandler } from '@modelcontextprotocol/server';
import type { McpLabAppliedFault, McpLabFaultRuntime } from './fault-runtime.js';
import type { McpLabProtocolEra, McpLabProtocolMethod } from './faults.js';
import {
  type McpLabHttpProtocolCoordinate,
  oauthFaultMethod,
  protocolCoordinate,
} from './http-coordinates.js';

export interface McpLabHttpFaultScopes {
  readonly authorization: boolean;
  readonly deferProtocol: boolean;
  readonly nodeDispatch: boolean;
  readonly protocol: boolean;
  readonly transport: boolean;
}

export const IN_PROCESS_HTTP_FAULT_SCOPES: McpLabHttpFaultScopes = Object.freeze({
  authorization: false,
  deferProtocol: false,
  nodeDispatch: false,
  protocol: true,
  transport: true,
});

export const OAUTH_OUTER_FAULT_SCOPES: McpLabHttpFaultScopes = Object.freeze({
  authorization: true,
  deferProtocol: true,
  nodeDispatch: true,
  protocol: false,
  transport: true,
});

export const LOOPBACK_HTTP_FAULT_SCOPES: McpLabHttpFaultScopes = Object.freeze({
  ...IN_PROCESS_HTTP_FAULT_SCOPES,
  nodeDispatch: true,
});

interface McpLabPreparedExchange {
  readonly authorizationMethod?: McpLabProtocolMethod;
  readonly correlationId: string;
  readonly faults: readonly McpLabAppliedFault[];
  readonly protocol?: McpLabHttpProtocolCoordinate;
  readonly terminal: boolean;
}

class McpLabTerminalFaultResponse extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super('MCP lab fault terminated the exchange with a response');
    this.name = 'McpLabTerminalFaultResponse';
    this.response = response;
  }
}

function isTerminalFault(applied: McpLabAppliedFault | undefined): boolean {
  return applied !== undefined && applied.fault.kind !== 'delay';
}

export class McpLabHttpFaultExecutor {
  readonly #activeFetches = new Set<Promise<Response>>();
  readonly #era: McpLabProtocolEra;
  readonly #recordError: (correlationId: string, error: unknown) => void;
  readonly #runtime: McpLabFaultRuntime;
  readonly #preparedByRequest = new WeakMap<Request, McpLabPreparedExchange>();
  #closed = false;
  #ingressTail: Promise<void> = Promise.resolve();

  constructor(
    runtime: McpLabFaultRuntime,
    era: McpLabProtocolEra,
    recordError: (correlationId: string, error: unknown) => void
  ) {
    this.#runtime = runtime;
    this.#era = era;
    this.#recordError = recordError;
  }

  prepare(
    request: Request,
    scopes: McpLabHttpFaultScopes
  ): Promise<McpLabPreparedExchange | undefined> {
    if (this.#closed) {
      return Promise.reject(new Error('MCP lab HTTP fault executor is closed'));
    }
    if (!this.#runtime.requiresHttpQualification()) {
      return Promise.resolve(undefined);
    }
    const prepared = this.#ingressTail.then(() => this.#prepareNow(request, scopes));
    this.#ingressTail = prepared.then(
      () => undefined,
      () => undefined
    );
    return prepared;
  }

  async #prepareNow(
    request: Request,
    scopes: McpLabHttpFaultScopes
  ): Promise<McpLabPreparedExchange | undefined> {
    if (!this.#runtime.requiresHttpQualification()) {
      return;
    }
    const hasTransportFault = this.#runtime.hasRemainingPhase('transport');
    const protocol = await this.#qualifyProtocol(request, scopes, hasTransportFault);
    const authorizationMethod = this.#qualifyAuthorization(request, scopes, hasTransportFault);
    if (!(protocol || authorizationMethod)) {
      return;
    }
    const suppliedCorrelation = request.headers.get('x-mcp-lab-correlation-id') ?? undefined;
    const correlationId = this.#runtime.reserveCorrelation(suppliedCorrelation);
    const faults: McpLabAppliedFault[] = [];
    const dispatchFault = this.#consumeOptionalTransportFault(
      scopes.nodeDispatch,
      'node/dispatch',
      correlationId,
      faults
    );
    if (isTerminalFault(dispatchFault)) {
      return this.#createExchange(authorizationMethod, correlationId, faults, protocol, true);
    }
    const requestFault = this.#consumeOptionalTransportFault(
      scopes.transport,
      'http/request',
      correlationId,
      faults
    );
    if (isTerminalFault(requestFault)) {
      return this.#createExchange(authorizationMethod, correlationId, faults, protocol, true);
    }
    const protocolFault =
      scopes.protocol && protocol
        ? this.#runtime.consume(protocol.phase, protocol.method, correlationId)
        : undefined;
    if (protocolFault) {
      faults.push(protocolFault);
    }
    const exchange = this.#createExchange(
      authorizationMethod,
      correlationId,
      faults,
      protocol,
      isTerminalFault(protocolFault)
    );
    this.#preparedByRequest.set(request, exchange);
    return exchange;
  }

  #consumeOptionalTransportFault(
    enabled: boolean,
    method: 'http/request' | 'node/dispatch',
    correlationId: string,
    faults: McpLabAppliedFault[]
  ): McpLabAppliedFault | undefined {
    const fault = enabled ? this.#runtime.consume('transport', method, correlationId) : undefined;
    if (fault) {
      faults.push(fault);
    }
    return fault;
  }

  #createExchange(
    authorizationMethod: McpLabProtocolMethod | undefined,
    correlationId: string,
    faults: readonly McpLabAppliedFault[],
    protocol: McpLabHttpProtocolCoordinate | undefined,
    terminal: boolean
  ): McpLabPreparedExchange {
    return Object.freeze({
      ...(authorizationMethod ? { authorizationMethod } : {}),
      correlationId,
      faults: Object.freeze([...faults]),
      ...(protocol ? { protocol } : {}),
      terminal,
    });
  }

  #qualifyAuthorization(
    request: Request,
    scopes: McpLabHttpFaultScopes,
    hasTransportFault: boolean
  ): McpLabProtocolMethod | undefined {
    if (
      !(
        scopes.authorization &&
        (hasTransportFault || this.#runtime.hasRemainingPhase('authorization'))
      )
    ) {
      return;
    }
    return oauthFaultMethod(request);
  }

  async #qualifyProtocol(
    request: Request,
    scopes: McpLabHttpFaultScopes,
    hasTransportFault: boolean
  ): Promise<McpLabHttpProtocolCoordinate | undefined> {
    const hasProtocolFault = (['initialization', 'operation', 'subscription'] as const).some(
      (phase) => this.#runtime.hasRemainingPhase(phase)
    );
    if (!(hasTransportFault || ((scopes.protocol || scopes.deferProtocol) && hasProtocolFault))) {
      return;
    }
    return protocolCoordinate(request, this.#era);
  }

  async injectAuthorizationFault(request: Request, method: McpLabProtocolMethod): Promise<void> {
    const prepared = this.#preparedByRequest.get(request);
    if (!prepared || prepared.authorizationMethod !== method) {
      return;
    }
    await this.#injectDeferredFault(prepared, 'authorization', method, request.signal);
  }

  async injectAuthenticatedProtocolFault(request: Request): Promise<void> {
    const prepared = this.#preparedByRequest.get(request);
    if (!prepared?.protocol) {
      return;
    }
    await this.#injectDeferredFault(
      prepared,
      prepared.protocol.phase,
      prepared.protocol.method,
      request.signal
    );
  }

  parsedBodyFor(request: Request): unknown {
    return this.#preparedByRequest.get(request)?.protocol?.parsedBody;
  }

  async #injectDeferredFault(
    prepared: McpLabPreparedExchange,
    phase: Parameters<McpLabFaultRuntime['consume']>[0],
    method: Parameters<McpLabFaultRuntime['consume']>[1],
    signal: AbortSignal
  ): Promise<void> {
    const fault = this.#runtime.consume(phase, method, prepared.correlationId);
    if (!fault) {
      return;
    }
    const response = await this.#runtime.applyHttpFault(fault, signal);
    if (response) {
      throw new McpLabTerminalFaultResponse(response);
    }
  }

  fetchPrepared(
    prepared: McpLabPreparedExchange,
    request: Request,
    handler: McpHttpHandler,
    options: McpHandlerRequestOptions | undefined,
    scopes: McpLabHttpFaultScopes
  ): Promise<Response> {
    const fetch = this.#fetchPrepared(prepared, request, handler, options, scopes);
    this.#activeFetches.add(fetch);
    void fetch.then(
      () => this.#activeFetches.delete(fetch),
      () => this.#activeFetches.delete(fetch)
    );
    return fetch;
  }

  async #fetchPrepared(
    prepared: McpLabPreparedExchange,
    request: Request,
    handler: McpHttpHandler,
    options: McpHandlerRequestOptions | undefined,
    scopes: McpLabHttpFaultScopes
  ): Promise<Response> {
    try {
      for (const fault of prepared.faults) {
        const response = await this.#runtime.applyHttpFault(fault, request.signal);
        if (response) {
          return response;
        }
      }
      if (prepared.terminal) {
        throw new Error('MCP lab terminal HTTP fault did not terminate the exchange');
      }
      const response = await handler.fetch(request, {
        ...options,
        ...(prepared.protocol ? { parsedBody: prepared.protocol.parsedBody } : {}),
      });
      if (!scopes.transport) {
        return response;
      }
      const responseFault = this.#runtime.consume(
        'transport',
        'http/response',
        prepared.correlationId
      );
      return responseFault
        ? ((await this.#runtime.applyHttpFault(responseFault, request.signal, response)) ??
            response)
        : response;
    } catch (error) {
      if (error instanceof McpLabTerminalFaultResponse) {
        return error.response;
      }
      this.#recordError(prepared.correlationId, error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#ingressTail;
    await Promise.allSettled([...this.#activeFetches]);
  }
}

export function withMcpLabHttpFaults(
  handler: McpHttpHandler,
  runtime: McpLabFaultRuntime,
  recordError: (correlationId: string, error: unknown) => void,
  era: McpLabProtocolEra,
  scopes: McpLabHttpFaultScopes = IN_PROCESS_HTTP_FAULT_SCOPES
): McpHttpHandler {
  const executor = new McpLabHttpFaultExecutor(runtime, era, recordError);
  return {
    bus: handler.bus,
    async close() {
      await executor.close();
      await handler.close();
    },
    async fetch(request, options) {
      const prepared = await executor.prepare(request, scopes);
      return prepared
        ? executor.fetchPrepared(prepared, request, handler, options, scopes)
        : handler.fetch(request, options);
    },
    notify: handler.notify,
  };
}
