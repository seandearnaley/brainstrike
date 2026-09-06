import { McpAppFrameRpcError } from './frame-bridge.js';
import { parseMcpAppJsonRecord, parseMcpAppRequestId } from './messages.js';
import type {
  McpAppGeneration,
  McpAppOwnedTool,
  McpAppProvenanceAuthority,
  McpAppToolCall,
} from './provenance.js';
import { expectExactKeys, expectRecord, type UnknownRecord } from './validation.js';

export type McpAppPermissionDecision = 'allow' | 'ask' | 'deny';
export type McpAppToolRiskCategory = 'edit' | 'execute' | 'mcp' | 'read';

export interface McpAppPreparedToolCall {
  readonly decision: McpAppPermissionDecision;
  readonly execute: (context: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
  readonly riskCategory: McpAppToolRiskCategory;
}

export interface McpAppPendingApproval {
  readonly id: string;
  readonly riskCategory: McpAppToolRiskCategory;
  readonly toolName: string;
}

export interface McpAppToolCallAuthoritySnapshot {
  readonly listenerCount: number;
  readonly pendingApprovals: readonly McpAppPendingApproval[];
  readonly pendingCalls: number;
  readonly phase: 'closed' | 'open';
}

export interface McpAppToolCallPreparationContext {
  readonly id: string;
  readonly signal: AbortSignal;
}

interface OwnedCall {
  readonly call: McpAppToolCall;
  readonly controller: AbortController;
  readonly externalAbort?: () => void;
}

interface ApprovalWaiter {
  readonly approval: McpAppPendingApproval;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
}

export interface McpAppToolCallAuthorityOptions {
  readonly generation: McpAppGeneration;
  readonly onDiagnostic?: (error: Error) => void;
  readonly prepare: (
    call: McpAppToolCall,
    context: McpAppToolCallPreparationContext
  ) => Promise<McpAppPreparedToolCall>;
  readonly provenance: McpAppProvenanceAuthority;
  readonly release: (
    call: McpAppToolCall,
    context: McpAppToolCallPreparationContext
  ) => Promise<void>;
}

function toError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function abortReason(signal: AbortSignal): Error {
  return toError(signal.reason, 'MCP Apps tool call cancelled');
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function parseCall(value: unknown): Readonly<{
  arguments: Readonly<UnknownRecord>;
  id: number | string;
  name: string;
}> {
  const label = 'MCP Apps app-originated tool call';
  const record = expectRecord(value, label);
  expectExactKeys(record, ['arguments', 'id', 'name'], ['id', 'name'], label);
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 256 || name.trim() !== name) {
    throw new TypeError(`${label}.name must contain 1 to 256 characters`);
  }
  return Object.freeze({
    arguments:
      record['arguments'] === undefined
        ? Object.freeze({})
        : parseMcpAppJsonRecord(record['arguments'], `${label}.arguments`),
    id: parseMcpAppRequestId(record['id'], label),
    name,
  });
}

export class McpAppToolCallAuthority {
  readonly #approvals = new Map<string, ApprovalWaiter>();
  #approvalSequence = 0;
  #closed = false;
  #closePromise: Promise<McpAppToolCallAuthoritySnapshot> | undefined;
  readonly #generation: McpAppGeneration;
  readonly #idleWaiters = new Set<() => void>();
  /**
   * Preparation ids are process-global at the desktop host, while every app
   * mount owns its own authority opened at generation 1 with a local
   * sequence; this nonce keeps two mounted cards from colliding.
   */
  readonly #instanceId = crypto.randomUUID();
  readonly #listeners = new Set<() => void>();
  readonly #onDiagnostic: (error: Error) => void;
  readonly #ownedCalls = new Set<OwnedCall>();
  readonly #prepare: McpAppToolCallAuthorityOptions['prepare'];
  #preparationSequence = 0;
  readonly #provenance: McpAppProvenanceAuthority;
  readonly #release: McpAppToolCallAuthorityOptions['release'];
  #snapshot: McpAppToolCallAuthoritySnapshot;
  readonly #toolsByName: ReadonlyMap<string, McpAppOwnedTool>;

  constructor(options: McpAppToolCallAuthorityOptions) {
    this.#generation = options.generation;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#prepare = options.prepare;
    this.#provenance = options.provenance;
    this.#release = options.release;
    this.#toolsByName = new Map(
      options.provenance.toolsFor(options.generation, 'app').map((tool) => [tool.name, tool])
    );
    this.#snapshot = this.#createSnapshot();
  }

  get snapshot(): McpAppToolCallAuthoritySnapshot {
    return this.#snapshot;
  }

  #createSnapshot(): McpAppToolCallAuthoritySnapshot {
    return Object.freeze({
      listenerCount: this.#listeners.size,
      pendingApprovals: Object.freeze(
        Array.from(this.#approvals.values(), (entry) => entry.approval)
      ),
      pendingCalls: this.#ownedCalls.size,
      phase: this.#closed ? 'closed' : 'open',
    });
  }

  approve(approvalId: string): boolean {
    const waiter = this.#approvals.get(approvalId);
    if (!waiter) {
      return false;
    }
    this.#approvals.delete(approvalId);
    waiter.resolve();
    this.#publish();
    return true;
  }

  deny(approvalId: string): boolean {
    const waiter = this.#approvals.get(approvalId);
    if (!waiter) {
      return false;
    }
    this.#approvals.delete(approvalId);
    waiter.reject(new McpAppFrameRpcError(-32_001, 'MCP Apps tool call declined by user'));
    this.#publish();
    return true;
  }

  async call(
    value: unknown,
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<Readonly<UnknownRecord>> {
    if (this.#closed) {
      throw new TypeError('MCP Apps tool-call authority is closed');
    }
    const parsed = parseCall(value);
    const tool = this.#toolsByName.get(parsed.name);
    if (!tool) {
      throw new McpAppFrameRpcError(-32_601, 'MCP Apps tool is not available');
    }
    const call = this.#provenance.beginToolCall(this.#generation, tool, {
      audience: 'app',
      id: parsed.id,
      input: parsed.arguments,
    });
    const controller = new AbortController();
    const externalSignal = options.signal;
    const externalAbort = externalSignal
      ? (): void => controller.abort(abortReason(externalSignal))
      : undefined;
    if (externalSignal && externalAbort) {
      externalSignal.addEventListener('abort', externalAbort, { once: true });
      if (externalSignal.aborted) {
        externalAbort();
      }
    }
    const owned: OwnedCall = {
      call,
      controller,
      ...(externalAbort ? { externalAbort } : {}),
    };
    this.#ownedCalls.add(owned);
    this.#publish();
    this.#preparationSequence += 1;
    const preparation = Object.freeze({
      id: `mcp-app-preparation-${this.#instanceId}-${this.#generation.generation}-${this.#preparationSequence}`,
      signal: controller.signal,
    });
    let completed = false;
    try {
      let executionSettled = false;
      const result = await this.#runWithPreparationRelease(
        call,
        preparation,
        () => !executionSettled,
        async () => {
          const prepared = await raceWithAbort(
            Promise.resolve().then(() => this.#prepare(call, preparation)),
            controller.signal
          );
          if (prepared.decision === 'deny') {
            throw new McpAppFrameRpcError(-32_001, 'MCP Apps tool call denied by policy');
          }
          if (prepared.decision === 'ask') {
            await this.#waitForApproval(call, prepared, controller.signal);
          }
          const execution = await raceWithAbort(
            Promise.resolve().then(() => prepared.execute({ signal: controller.signal })),
            controller.signal
          );
          executionSettled = true;
          return execution;
        }
      );
      const ownedResult = this.#provenance.completeToolCall(this.#generation, call, result);
      completed = true;
      return ownedResult.result;
    } catch (error: unknown) {
      const failure = toError(error, 'MCP Apps tool call failed');
      this.#onDiagnostic(failure);
      throw failure;
    } finally {
      if (!completed) {
        // cancelToolCall throws when the generation was torn down mid-call;
        // that must not skip the cleanup below or replace the real failure.
        try {
          this.#provenance.cancelToolCall(this.#generation, call);
        } catch (cancelError: unknown) {
          this.#onDiagnostic(toError(cancelError, 'MCP Apps tool call cancellation failed'));
        }
      }
      this.#ownedCalls.delete(owned);
      this.#publish();
      this.#resolveIdleWaiters();
      if (externalSignal && externalAbort) {
        externalSignal.removeEventListener('abort', externalAbort);
      }
    }
  }

  async #runWithPreparationRelease<T>(
    call: McpAppToolCall,
    context: McpAppToolCallPreparationContext,
    shouldRelease: () => boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error: unknown) {
      if (!shouldRelease()) {
        throw error;
      }
      try {
        await this.#release(call, context);
      } catch (releaseError: unknown) {
        throw new AggregateError(
          [error, releaseError],
          'MCP Apps tool call and prepared-call release both failed'
        );
      }
      throw error;
    }
    if (shouldRelease()) {
      await this.#release(call, context);
    }
    return result;
  }

  close(): Promise<McpAppToolCallAuthoritySnapshot> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closed = true;
    const reason = new Error('MCP Apps tool-call authority closed');
    for (const owned of this.#ownedCalls) {
      owned.controller.abort(reason);
    }
    for (const waiter of this.#approvals.values()) {
      waiter.reject(reason);
    }
    this.#approvals.clear();
    this.#publish();
    this.#listeners.clear();
    this.#snapshot = this.#createSnapshot();
    this.#closePromise = this.#waitForIdle().then(() => {
      this.#snapshot = this.#createSnapshot();
      return this.#snapshot;
    });
    return this.#closePromise;
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) {
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#publish();
    return () => {
      this.#listeners.delete(listener);
      this.#snapshot = this.#createSnapshot();
    };
  }

  async #waitForApproval(
    call: McpAppToolCall,
    prepared: McpAppPreparedToolCall,
    signal: AbortSignal
  ): Promise<void> {
    this.#approvalSequence += 1;
    const id = `mcp-app-approval-${this.#approvalSequence}`;
    const approval = Object.freeze({
      id,
      riskCategory: prepared.riskCategory,
      toolName: call.toolName,
    });
    await raceWithAbort(
      new Promise<void>((resolve, reject) => {
        this.#approvals.set(id, { approval, reject, resolve });
        this.#publish();
      }),
      signal
    ).finally(() => {
      this.#approvals.delete(id);
      this.#publish();
    });
  }

  #publish(): void {
    this.#snapshot = this.#createSnapshot();
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  #resolveIdleWaiters(): void {
    if (this.#ownedCalls.size > 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }

  #waitForIdle(): Promise<void> {
    if (this.#ownedCalls.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }
}
