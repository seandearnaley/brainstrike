import type { Client } from '@modelcontextprotocol/client';

export interface McpClientCapabilityCloseReport {
  readonly activeHandlerCallsAtClose: number;
  readonly handlerCallsSettled: number;
  readonly notificationHandlersRemoved: number;
  readonly requestHandlersRemoved: number;
}

const LEASE_CLOSED_REASON = new Error('MCP client capability lease closed');

export class McpClientCapabilityLeaseOwner {
  readonly #abortController = new AbortController();
  readonly #client: Client;
  #closePromise: Promise<McpClientCapabilityCloseReport> | undefined;
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #notificationMethods: string[] = [];
  readonly #requestMethods: string[] = [];

  constructor(client: Client) {
    this.#client = client;
  }

  close(): Promise<McpClientCapabilityCloseReport> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  recordNotificationHandler(method: string): void {
    this.#notificationMethods.push(method);
  }

  recordRequestHandler(method: string): void {
    this.#requestMethods.push(method);
  }

  rollbackInstall(cause: unknown): never {
    this.#abortController.abort(LEASE_CLOSED_REASON);
    const failures = this.#removeHandlers();
    if (failures.length > 0) {
      throw new AggregateError([cause, ...failures], 'MCP capability handler installation failed');
    }
    throw cause;
  }

  track<T>(requestSignal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closePromise || this.#abortController.signal.aborted) {
      return Promise.reject(LEASE_CLOSED_REASON);
    }
    const signal = AbortSignal.any([requestSignal, this.#abortController.signal]);
    const operation = Promise.resolve().then(() => work(signal));
    this.#inFlight.add(operation);
    void operation.then(
      () => this.#inFlight.delete(operation),
      () => this.#inFlight.delete(operation)
    );
    return operation;
  }

  async #closeOnce(): Promise<McpClientCapabilityCloseReport> {
    const active = [...this.#inFlight];
    this.#abortController.abort(LEASE_CLOSED_REASON);
    const removalFailures = this.#removeHandlers();
    await Promise.allSettled(active);
    if (removalFailures.length > 0) {
      throw new AggregateError(removalFailures, 'Failed to remove MCP client capability handlers');
    }
    return Object.freeze({
      activeHandlerCallsAtClose: active.length,
      handlerCallsSettled: active.length,
      notificationHandlersRemoved: this.#notificationMethods.length,
      requestHandlersRemoved: this.#requestMethods.length,
    });
  }

  #removeHandlers(): unknown[] {
    const failures: unknown[] = [];
    for (const method of this.#requestMethods) {
      try {
        this.#client.removeRequestHandler(method);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const method of this.#notificationMethods) {
      try {
        this.#client.removeNotificationHandler(method);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
