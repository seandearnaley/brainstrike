import type {
  McpTaskAuthorityLease,
  McpTaskIdentity,
  McpTaskRecord,
  McpTaskRepository,
  McpTaskScope,
} from '@brainstrike/db';
import { McpTaskMetadataTooLargeError } from '@brainstrike/db';
import type { CreateTaskResult, GetTaskResult } from '@brainstrike/mcp-tasks-extension';
import type { JSONObject } from '@modelcontextprotocol/client';
import type { McpClientExtensionRequestContract } from './client-extension-registry';
import { MCP_TASKS_GET_REQUEST_CONTRACT } from './tasks-extension';
import {
  assertMcpTaskTimingProgress,
  createMcpTaskHandleUpdate,
  createMcpTaskOverflowUpdate,
  createMcpTaskUpdate,
  hasPendingMcpTaskDetail,
  type McpTaskTiming,
  readMcpTaskTiming,
  readStoredMcpTaskTiming,
  resolveMcpTaskDeadline,
  resolveMcpTaskPollDelay,
  TERMINAL_TASK_STATUSES,
} from './tasks-lifecycle-state';

export const DEFAULT_MCP_TASK_LIFECYCLE_LIMITS = Object.freeze({
  initialPollMs: 500,
  maxBackoffMs: 30_000,
  maxConcurrentPolls: 4,
  maxConsecutiveFailures: 3,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  minimumPollMs: 100,
  pollRequestTimeoutMs: 30_000,
});

export interface McpTaskLifecycleLimits {
  readonly initialPollMs: number;
  readonly maxBackoffMs: number;
  readonly maxConcurrentPolls: number;
  readonly maxConsecutiveFailures: number;
  readonly maxLifetimeMs: number;
  readonly minimumPollMs: number;
  readonly pollRequestTimeoutMs: number;
}

export interface McpTaskRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface McpTaskPollingClient {
  requestExtension<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: Params,
    options?: McpTaskRequestOptions
  ): Promise<Result>;
}

export interface McpTrackedTask {
  readonly record: McpTaskRecord;
  readonly settled: Promise<McpTaskRecord>;
}

export type McpTaskLifecycleStopReason =
  | 'cancelled'
  | 'closed'
  | 'disconnect'
  | 'reset'
  | 'restart'
  | 'server-removed'
  | 'server-replaced';

export class McpTaskLifecycleStoppedError extends Error {
  constructor(readonly reason: McpTaskLifecycleStopReason) {
    super(`MCP task lifecycle stopped: ${reason}`);
    this.name = 'McpTaskLifecycleStoppedError';
  }
}

export class McpTaskObservationError extends Error {
  constructor(
    readonly taskId: string,
    readonly failures: number,
    cause: unknown
  ) {
    super(`MCP task "${taskId}" observation failed after ${failures} bounded attempts.`, {
      cause,
    });
    this.name = 'McpTaskObservationError';
  }
}

export interface McpTaskLifecycleOptions {
  readonly authority: McpTaskAuthorityLease;
  readonly client: McpTaskPollingClient;
  readonly limits?: McpTaskLifecycleLimits;
  readonly onUpdate: (record: McpTaskRecord) => Promise<void> | void;
  readonly repository: McpTaskRepository;
}

interface ActiveTask {
  readonly controller: AbortController;
  readonly settled: Promise<McpTaskRecord>;
  readonly wake: PollWakeState;
}

interface PollWakeState {
  release: (() => void) | undefined;
  requested: boolean;
}

interface PollWaiter {
  readonly grant: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError(`MCP task lifecycle ${field} must be a positive safe integer.`);
  }
  return value;
}

function requireTaskIdentity(taskId: string, expectedTaskId: string): void {
  if (taskId !== expectedTaskId) {
    throw new Error(
      `MCP task response identity mismatch: expected=${expectedTaskId}, actual=${taskId}`
    );
  }
}

function normalizeLimits(input: McpTaskLifecycleLimits | undefined): McpTaskLifecycleLimits {
  const limits = input ?? DEFAULT_MCP_TASK_LIFECYCLE_LIMITS;
  const normalized = {
    initialPollMs: requirePositiveInteger(limits.initialPollMs, 'initialPollMs'),
    maxBackoffMs: requirePositiveInteger(limits.maxBackoffMs, 'maxBackoffMs'),
    maxConcurrentPolls: requirePositiveInteger(limits.maxConcurrentPolls, 'maxConcurrentPolls'),
    maxConsecutiveFailures: requirePositiveInteger(
      limits.maxConsecutiveFailures,
      'maxConsecutiveFailures'
    ),
    maxLifetimeMs: requirePositiveInteger(limits.maxLifetimeMs, 'maxLifetimeMs'),
    minimumPollMs: requirePositiveInteger(limits.minimumPollMs, 'minimumPollMs'),
    pollRequestTimeoutMs: requirePositiveInteger(
      limits.pollRequestTimeoutMs,
      'pollRequestTimeoutMs'
    ),
  };
  if (normalized.maxBackoffMs < normalized.initialPollMs) {
    throw new TypeError('MCP task lifecycle maxBackoffMs must be at least initialPollMs.');
  }
  return Object.freeze(normalized);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The MCP task lifecycle was aborted.', 'AbortError');
}

function raceAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export class McpTaskLifecycle {
  private readonly active = new Map<string, ActiveTask>();
  private readonly authority: McpTaskAuthorityLease;
  private readonly client: McpTaskPollingClient;
  private readonly lifecycleController = new AbortController();
  private readonly limits: McpTaskLifecycleLimits;
  private readonly onUpdate: McpTaskLifecycleOptions['onUpdate'];
  private readonly pendingCreates = new Set<Promise<McpTrackedTask>>();
  private readonly pollWaiters: PollWaiter[] = [];
  private readonly repository: McpTaskRepository;
  private readonly scope: McpTaskScope;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private activePolls = 0;
  private stopPromise: Promise<void> | undefined;

  constructor(options: McpTaskLifecycleOptions) {
    this.authority = Object.freeze({ ...options.authority });
    this.client = options.client;
    this.limits = normalizeLimits(options.limits);
    this.onUpdate = options.onUpdate;
    this.repository = options.repository;
    this.scope = Object.freeze({
      authorityEpoch: options.authority.authorityEpoch,
      principalId: options.authority.principalId,
      resource: options.authority.resource,
      serverId: options.authority.serverId,
    });
  }

  track(task: CreateTaskResult, signal?: AbortSignal): Promise<McpTrackedTask> {
    this.requireOpen(signal);
    // Sole-authority guard BEFORE the durable write: a second track() of the
    // same handle must be a clean rejection, not a persisted row plus a throw.
    if (this.active.has(task.taskId)) {
      throw new Error(`MCP task "${task.taskId}" is already tracked by this lifecycle.`);
    }
    const operation = this.persistAndStart(task, signal);
    this.pendingCreates.add(operation);
    void operation.finally(() => this.pendingCreates.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async persistAndStart(
    task: CreateTaskResult,
    signal: AbortSignal | undefined
  ): Promise<McpTrackedTask> {
    const timing = readMcpTaskTiming(task);
    const identity = this.identity(task.taskId);
    const record = await this.createRecord(identity, task);
    this.requireOpen(signal);
    return this.start(record, timing, signal);
  }

  async recover(signal?: AbortSignal): Promise<readonly McpTrackedTask[]> {
    this.requireOpen(signal);
    const records = await this.repository.listActive(this.authority);
    this.requireOpen(signal);
    const resumable = records.map((record) => ({
      record,
      timing: readStoredMcpTaskTiming(record),
    }));
    // All or nothing: a handle that fails to start must not leave earlier
    // handles polling with no caller holding their `settled` promise.
    const started: McpTrackedTask[] = [];
    try {
      for (const { record, timing } of resumable) {
        started.push(this.start(record, timing, signal));
      }
    } catch (error) {
      for (const tracked of started) {
        this.active.get(tracked.record.taskId)?.controller.abort(error);
      }
      throw error;
    }
    return started;
  }

  /**
   * Schedules an immediate poll for a tracked task. A notification for a task
   * this lifecycle no longer (or never) owns is ordinary MCP timing — the
   * final status notification routinely lands after the in-flight `tasks/get`
   * already settled the task — so it is reported as `false`, not thrown.
   * Wake carries no state into persistence; ignoring it is a no-op.
   */
  wake(taskId: string): boolean {
    this.requireOpen();
    const task = this.active.get(taskId);
    if (!task) {
      return false;
    }
    task.wake.requested = true;
    task.wake.release?.();
    return true;
  }

  async stop(reason: McpTaskLifecycleStopReason): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const failure = new McpTaskLifecycleStoppedError(reason);
    this.lifecycleController.abort(failure);
    for (const task of this.active.values()) {
      task.controller.abort(failure);
    }
    this.stopPromise = this.finishStop(reason);
    return this.stopPromise;
  }

  snapshot(): {
    readonly activePolls: number;
    readonly activeTasks: number;
    readonly pendingCreates: number;
    readonly queuedPolls: number;
    readonly timers: number;
  } {
    return Object.freeze({
      activePolls: this.activePolls,
      activeTasks: this.active.size,
      pendingCreates: this.pendingCreates.size,
      queuedPolls: this.pollWaiters.length,
      timers: this.timers.size,
    });
  }

  private start(
    record: McpTaskRecord,
    initialTiming: McpTaskTiming,
    callerSignal: AbortSignal | undefined
  ): McpTrackedTask {
    if (TERMINAL_TASK_STATUSES.has(record.status) || record.blockedDiagnostic !== null) {
      return Object.freeze({ record, settled: Promise.resolve(record) });
    }
    if (this.active.has(record.taskId)) {
      throw new Error(`MCP task "${record.taskId}" is already tracked by this lifecycle.`);
    }
    const controller = new AbortController();
    const signals = [this.lifecycleController.signal, controller.signal];
    if (callerSignal) {
      signals.push(callerSignal);
    }
    const signal = AbortSignal.any(signals);
    // A create response that claimed a status without its detail fields was
    // persisted as `working` with a pending-detail marker; the first poll
    // runs at once so the detailed state is fetched before any real waiting.
    const wake: PollWakeState = {
      release: undefined,
      requested: hasPendingMcpTaskDetail(record),
    };
    const settled = this.poll(record, initialTiming, signal, wake).finally(() => {
      this.active.delete(record.taskId);
    });
    void settled.catch(() => undefined);
    this.active.set(record.taskId, { controller, settled, wake });
    return Object.freeze({ record, settled });
  }

  private async poll(
    initialRecord: McpTaskRecord,
    initialTiming: McpTaskTiming,
    signal: AbortSignal,
    wake: PollWakeState
  ): Promise<McpTaskRecord> {
    let backoffMs = this.limits.initialPollMs;
    let consecutiveFailures = 0;
    let latestTiming = initialTiming;
    const localDeadline = Date.now() + this.limits.maxLifetimeMs;
    while (true) {
      const deadline = resolveMcpTaskDeadline(
        latestTiming,
        initialRecord,
        localDeadline,
        this.limits.maxLifetimeMs
      );
      const requestedDelay = resolveMcpTaskPollDelay(
        latestTiming,
        backoffMs,
        consecutiveFailures,
        this.limits
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`MCP task "${initialRecord.taskId}" exceeded its bounded lifetime.`);
      }
      await this.wait(Math.min(requestedDelay, remainingMs), signal, wake);
      if (Date.now() >= deadline) {
        throw new Error(`MCP task "${initialRecord.taskId}" exceeded its bounded lifetime.`);
      }
      const release = await this.acquirePollPermit(signal);
      wake.requested = false;
      // The permit wait can outlast the deadline computed before it; a poll
      // must not be issued, nor a late response persisted, past the lifetime.
      const remainingAfterPermit = deadline - Date.now();
      if (remainingAfterPermit <= 0) {
        release();
        throw new Error(`MCP task "${initialRecord.taskId}" exceeded its bounded lifetime.`);
      }
      let result: GetTaskResult;
      try {
        try {
          result = await this.requestTask(initialRecord.taskId, signal, remainingAfterPermit);
        } catch (cause) {
          consecutiveFailures += 1;
          this.assertPollRetry(initialRecord.taskId, cause, signal, consecutiveFailures);
          backoffMs = Math.min(backoffMs * 2, this.limits.maxBackoffMs);
          continue;
        }
      } finally {
        release();
      }
      if (signal.aborted) {
        throw abortReason(signal);
      }
      requireTaskIdentity(result.taskId, initialRecord.taskId);
      const resultTiming = readMcpTaskTiming(result);
      assertMcpTaskTimingProgress(latestTiming, resultTiming, initialRecord.taskId);
      const persisted = await this.updateRecord(this.identity(initialRecord.taskId), result);
      if (signal.aborted) {
        throw abortReason(signal);
      }
      await raceAbort(Promise.resolve(this.onUpdate(persisted)), signal);
      if (TERMINAL_TASK_STATUSES.has(persisted.status) || persisted.blockedDiagnostic !== null) {
        return persisted;
      }
      consecutiveFailures = 0;
      latestTiming = resultTiming;
      if (result.pollIntervalMs === undefined) {
        backoffMs = Math.min(backoffMs * 2, this.limits.maxBackoffMs);
      }
    }
  }

  private async requestTask(
    taskId: string,
    signal: AbortSignal,
    remainingLifetimeMs: number
  ): Promise<GetTaskResult> {
    return await raceAbort(
      this.client.requestExtension(
        MCP_TASKS_GET_REQUEST_CONTRACT,
        { taskId },
        { signal, timeout: Math.min(this.limits.pollRequestTimeoutMs, remainingLifetimeMs) }
      ),
      signal
    );
  }

  private assertPollRetry(
    taskId: string,
    cause: unknown,
    signal: AbortSignal,
    failures: number
  ): void {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    if (failures >= this.limits.maxConsecutiveFailures) {
      throw new McpTaskObservationError(taskId, failures, cause);
    }
  }

  private identity(taskId: string): McpTaskIdentity {
    return { ...this.scope, taskId };
  }

  private requireOpen(callerSignal?: AbortSignal): void {
    if (this.lifecycleController.signal.aborted) {
      throw abortReason(this.lifecycleController.signal);
    }
    if (callerSignal?.aborted) {
      throw abortReason(callerSignal);
    }
  }

  private wait(delayMs: number, signal: AbortSignal, wake: PollWakeState): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (wake.requested) {
      wake.requested = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      this.timers.add(timer);
      const onAbort = (): void => {
        cleanup();
        reject(abortReason(signal));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.timers.delete(timer);
        signal.removeEventListener('abort', onAbort);
        if (wake.release === onWake) {
          wake.release = undefined;
        }
      };
      const onWake = (): void => {
        wake.requested = false;
        cleanup();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      wake.release = onWake;
    });
  }

  private acquirePollPermit(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.activePolls < this.limits.maxConcurrentPolls) {
      this.activePolls += 1;
      return Promise.resolve(this.createPollRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: PollWaiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          this.activePolls += 1;
          resolve(this.createPollRelease());
        },
        reject,
        signal,
      };
      const onAbort = (): void => {
        const index = this.pollWaiters.indexOf(waiter);
        if (index >= 0) {
          this.pollWaiters.splice(index, 1);
        }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pollWaiters.push(waiter);
    });
  }

  private createPollRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activePolls -= 1;
      let waiter = this.pollWaiters.shift();
      while (waiter?.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        waiter = this.pollWaiters.shift();
      }
      if (waiter) {
        waiter.grant();
      }
    };
  }

  private async createRecord(
    identity: McpTaskIdentity,
    task: CreateTaskResult
  ): Promise<McpTaskRecord> {
    try {
      return await this.repository.create(
        { ...identity, ...createMcpTaskHandleUpdate(task) },
        this.authority
      );
    } catch (cause) {
      if (!(cause instanceof McpTaskMetadataTooLargeError)) {
        throw cause;
      }
      return await this.repository.create(
        { ...identity, ...createMcpTaskOverflowUpdate(task, cause) },
        this.authority
      );
    }
  }

  private async updateRecord(
    identity: McpTaskIdentity,
    task: GetTaskResult
  ): Promise<McpTaskRecord> {
    try {
      return await this.repository.update(identity, createMcpTaskUpdate(task), this.authority);
    } catch (cause) {
      if (!(cause instanceof McpTaskMetadataTooLargeError)) {
        throw cause;
      }
      return await this.repository.update(
        identity,
        createMcpTaskOverflowUpdate(task, cause),
        this.authority
      );
    }
  }

  private async finishStop(reason: McpTaskLifecycleStopReason): Promise<void> {
    await Promise.allSettled([
      ...this.pendingCreates,
      ...[...this.active.values()].map(({ settled }) => settled),
    ]);
    if (
      reason === 'disconnect' ||
      reason === 'reset' ||
      reason === 'server-removed' ||
      reason === 'server-replaced'
    ) {
      await this.repository.retireAuthority(this.authority);
    }
  }
}
