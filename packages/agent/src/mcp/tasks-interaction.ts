import type { McpTaskIdentity, McpTaskScope } from '@brainstrike/db';
import {
  parseMcpCancelTaskParams,
  parseMcpUpdateTaskParams,
  type TaskStatus,
} from '@brainstrike/mcp-tasks-extension';
import type { ElicitRequest, ElicitResult, JSONObject } from '@modelcontextprotocol/client';
import {
  fulfillMcpElicitationRequest,
  type McpClientHandlerContext,
  type McpElicitationCapability,
} from './client-capabilities';
import type { McpClientExtensionRequestContract } from './client-extension-registry';
import {
  MCP_TASKS_CANCEL_REQUEST_CONTRACT,
  MCP_TASKS_UPDATE_REQUEST_CONTRACT,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
} from './tasks-extension';
import type { McpTaskObservationPort } from './tasks-observation';

export interface McpTaskInteractionElicitationContext
  extends McpClientHandlerContext,
    McpTaskScope {
  readonly inputKey: string;
  readonly taskId: string;
}

export type McpTaskInteractionElicitationAuthority =
  McpElicitationCapability<McpTaskInteractionElicitationContext>;

export interface McpTaskInteractionRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface McpTaskInteractionClient {
  listenTasks(
    taskIds: readonly string[],
    handler: McpTasksNotificationHandler,
    options?: McpTaskInteractionRequestOptions
  ): Promise<McpTasksNotificationLease>;
  requestExtension<Params extends JSONObject, Result>(
    contract: McpClientExtensionRequestContract<Params, Result>,
    params: Params,
    options?: McpTaskInteractionRequestOptions
  ): Promise<Result>;
}

export interface McpTaskInteractionOptions {
  readonly client: McpTaskInteractionClient;
  readonly elicitation: McpTaskInteractionElicitationAuthority;
  readonly observationPort: McpTaskObservationPort;
  readonly scope: McpTaskScope;
}

export interface McpTaskCancellationResult extends McpTaskIdentity {
  readonly status: 'cancelled';
}

export class McpTaskCancellationOutcomeError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: 'completed' | 'failed'
  ) {
    super(`MCP task "${taskId}" reached "${status}" instead of the permitted cancelled state.`);
    this.name = 'McpTaskCancellationOutcomeError';
  }
}

/** The requestor's own `tasks/cancel` withdrew a task input request before it was answered. */
class McpTaskInputWithdrawnError extends Error {
  constructor(taskId: string, inputKey: string) {
    super(`MCP task "${taskId}" input request "${inputKey}" was withdrawn by cancellation.`);
    this.name = 'McpTaskInputWithdrawnError';
  }
}

/**
 * A dispatched `tasks/update` for this input ended without the server's
 * acknowledgement, so the server may have applied it. That includes a JSON-RPC
 * error response, which proves no ack but not that nothing was applied (pinned
 * ext-tasks 2026-07-28 tasks.md L791-801 permits internal errors; JSON-RPC 2.0
 * §5 gives no no-effect guarantee). The answer is never sent again
 * automatically (L377: the ack is eventually consistent, so a poll that still
 * lists the key proves nothing; L379: ignoring an answered key is only a SHOULD).
 */
export class McpTaskInputDeliveryUnknownError extends Error {
  constructor(
    readonly taskId: string,
    readonly inputKey: string
  ) {
    super(
      `MCP task "${taskId}" input "${inputKey}" has an unknown delivery outcome; it is not resent.`
    );
    this.name = 'McpTaskInputDeliveryUnknownError';
  }
}

/**
 * - `pending`: nothing was sent yet.
 * - `acknowledged`: the server returned the empty-result ack (L377). Only that
 *   positive response sets it, never a later task status.
 * - `unknown`: a send ended without the ack, whatever the error. It is terminal
 *   for the key.
 */
type InputDelivery = 'acknowledged' | 'pending' | 'unknown';

interface InputOperation {
  /** Settles with `outcome`: resolved only by the ack, rejected by anything else. */
  readonly acknowledged: PromiseWithResolvers<void>;
  readonly controller: AbortController;
  readonly decision: Promise<ElicitResult>;
  delivery: Promise<void> | undefined;
  readonly fingerprint: string;
  readonly inputKey: string;
  outcome: InputDelivery;
  retired: boolean;
  readonly taskId: string;
}

interface CancellationOperation {
  readonly promise: Promise<McpTaskCancellationResult>;
  readonly terminal: PromiseWithResolvers<'cancelled' | 'completed' | 'failed'>;
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['cancelled', 'completed', 'failed']);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('MCP task interaction was aborted.', 'AbortError');
}

function raceAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  let cleanup = (): void => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([operation, interrupted]).finally(cleanup);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('MCP task input request must contain only JSON values.');
  }
  return encoded;
}

function inputIdentity(taskId: string, inputKey: string): string {
  return `${taskId.length}:${taskId}${inputKey.length}:${inputKey}`;
}

export class McpTaskInteraction {
  private readonly client: McpTaskInteractionClient;
  private readonly cancellations = new Map<string, CancellationOperation>();
  private readonly controller = new AbortController();
  private readonly elicitation: McpTaskInteractionElicitationAuthority;
  private readonly inputs = new Map<string, InputOperation>();
  private readonly notificationTaskIds = new Set<string>();
  private readonly observationPort: McpTaskObservationPort;
  private readonly observationFailures = new Map<string, unknown>();
  private readonly scope: McpTaskScope;
  private readonly statuses = new Map<string, TaskStatus>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly taskIds = new Set<string>();
  private closePromise: Promise<void> | undefined;
  private notificationError: unknown;
  private releaseObservationConsumer: (() => void) | undefined;
  private started = false;
  private subscription: McpTasksNotificationLease | undefined;

  constructor(options: McpTaskInteractionOptions) {
    this.client = options.client;
    this.elicitation = options.elicitation;
    this.observationPort = options.observationPort;
    this.scope = Object.freeze({ ...options.scope });
  }

  async start(taskIds: readonly string[]): Promise<void> {
    this.requireOpen();
    if (this.started) {
      throw new Error('MCP task interaction notification subscription is already active.');
    }
    const uniqueTaskIds = new Set(taskIds);
    if (taskIds.length === 0 || uniqueTaskIds.size !== taskIds.length) {
      throw new Error('MCP task interaction requires non-empty unique task ids.');
    }
    this.releaseObservationConsumer = this.observationPort.subscribe({
      fail: (taskId, error) => this.recordObservationFailure(taskId, error),
      observe: async (task) => await this.observe(task),
    });
    this.started = true;
    for (const taskId of uniqueTaskIds) {
      this.admit(taskId);
    }
    const notificationReady = Promise.withResolvers<void>();
    try {
      const subscription = await raceAbort(
        this.client.listenTasks(
          taskIds,
          async (task) => {
            await notificationReady.promise;
            if (!this.notificationTaskIds.has(task.taskId)) {
              throw new Error(`MCP task notification was not acknowledged: "${task.taskId}".`);
            }
            this.observationPort.requestPoll(task.taskId);
          },
          { signal: this.controller.signal }
        ),
        this.controller.signal
      );
      if (this.controller.signal.aborted) {
        await subscription.close();
        throw abortReason(this.controller.signal);
      }
      if (subscription.honoredTaskIds.length === 0) {
        // Visible degradation: polling stays authoritative, but the absent
        // notification path is recorded rather than left indistinguishable
        // from a healthy one.
        this.notificationError = new Error(
          'MCP task notification subscription honored no requested task ids.'
        );
        notificationReady.resolve();
        await subscription.close();
        return;
      }
      for (const taskId of subscription.honoredTaskIds) {
        this.notificationTaskIds.add(taskId);
      }
      notificationReady.resolve();
      this.subscription = subscription;
      void subscription.closed.then(
        () => this.recordSubscriptionClosure(subscription),
        (error: unknown) => this.recordSubscriptionClosure(subscription, error)
      );
    } catch (error) {
      notificationReady.resolve();
      if (this.controller.signal.aborted) {
        throw abortReason(this.controller.signal);
      }
      this.notificationError = error;
    }
  }

  admit(taskId: string): void {
    this.requireOpen();
    if (!this.started) {
      throw new Error('MCP task interaction must be started before admitting tasks.');
    }
    if (this.taskIds.has(taskId)) {
      return;
    }
    this.taskIds.add(taskId);
    this.taskControllers.set(taskId, new AbortController());
  }

  notificationFailure(): unknown {
    return this.notificationError;
  }

  observationFailure(taskId: string): unknown {
    return this.observationFailures.get(taskId);
  }

  async observe(task: Parameters<McpTasksNotificationHandler>[0]): Promise<void> {
    this.requireOpen();
    if (!this.taskIds.has(task.taskId)) {
      throw new Error(`MCP task notification is outside the owned task set: "${task.taskId}".`);
    }
    const previousStatus = this.statuses.get(task.taskId);
    if (
      previousStatus !== undefined &&
      TERMINAL_TASK_STATUSES.has(previousStatus) &&
      task.status !== previousStatus
    ) {
      throw new Error(
        `MCP task "${task.taskId}" changed from terminal "${previousStatus}" to "${task.status}".`
      );
    }
    this.statuses.set(task.taskId, task.status);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      const cancellation = this.cancellations.get(task.taskId);
      cancellation?.terminal.resolve(task.status as 'cancelled' | 'completed' | 'failed');
      const taskController = this.taskControllers.get(task.taskId);
      taskController?.abort(
        new Error(`MCP task "${task.taskId}" reached terminal state "${task.status}".`)
      );
      this.taskControllers.delete(task.taskId);
      this.releaseTaskInputs(task.taskId);
    }
    const currentInputKeys =
      task.status === 'input_required'
        ? new Set(Object.keys(task.inputRequests))
        : new Set<string>();
    this.retireSupersededInputs(task.taskId, currentInputKeys);
    // Once tasks/cancel is sent the client owes the task no further input
    // (Tasks 2026-07-28, "Task Cancellation"); an eventually consistent
    // server may still list requests until it reports a terminal status.
    if (task.status !== 'input_required' || this.cancellations.has(task.taskId)) {
      return;
    }
    await Promise.all(
      Object.entries(task.inputRequests).map(async ([inputKey, request]) => {
        if (request['method'] !== 'elicitation/create') {
          throw new Error(
            `Unsupported MCP task input request method "${String(request['method'])}" for "${inputKey}".`
          );
        }
        await this.fulfillInput(task.taskId, inputKey, request as ElicitRequest);
      })
    );
  }

  cancel(taskId: string): Promise<McpTaskCancellationResult> {
    this.requireOpen();
    if (!this.taskIds.has(taskId)) {
      throw new Error(`MCP task cancellation is outside the owned task set: "${taskId}".`);
    }
    if (this.observationFailures.has(taskId)) {
      return Promise.reject(this.observationFailures.get(taskId));
    }
    const existing = this.cancellations.get(taskId);
    if (existing) {
      return existing.promise;
    }
    const status = this.statuses.get(taskId);
    if (status === 'cancelled') {
      return Promise.resolve(this.cancellationResult(taskId));
    }
    if (status === 'completed' || status === 'failed') {
      return Promise.reject(new McpTaskCancellationOutcomeError(taskId, status));
    }
    const terminal = Promise.withResolvers<'cancelled' | 'completed' | 'failed'>();
    // An observation failure may reject this before runCancellation awaits it.
    void terminal.promise.catch(() => undefined);
    // The sole poller is parked on this task's unanswered input, and only its
    // next poll can observe the terminal status. Withdrawing the input
    // releases it and refuses a late answer before tasks/cancel is sent.
    this.withdrawInputs(taskId);
    const promise = this.runCancellation(taskId, terminal.promise);
    const operation = { promise, terminal };
    this.cancellations.set(taskId, operation);
    void promise.finally(() => this.cancellations.delete(taskId)).catch(() => undefined);
    return promise;
  }

  /**
   * Withdraws a task's unanswered input WITHOUT cancelling the task. The host
   * calls this when its sole poller for the task ends while the session stays
   * open: nothing can observe the outcome of a late answer, so none may be
   * delivered. The durable handle stays recoverable, and a recovered poller
   * that observes the same input key presents it afresh, unless an answer to
   * that key was already sent with an unknown outcome.
   */
  withdraw(taskId: string): void {
    this.requireOpen();
    this.withdrawInputs(taskId);
  }

  /**
   * The server's empty-result ack of the `tasks/update` that carries this
   * input's answer. It rejects when that delivery's outcome is unknown, or when
   * the input is withdrawn, superseded or closed first. It never resends.
   */
  acknowledgement(taskId: string, inputKey: string): Promise<void> {
    const operation = this.inputs.get(inputIdentity(taskId, inputKey));
    if (!operation) {
      return Promise.reject(
        new Error(`MCP task "${taskId}" has no input "${inputKey}" in this interaction.`)
      );
    }
    return operation.acknowledged.promise;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.controller.abort(new DOMException('MCP task interaction closed.', 'AbortError'));
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  snapshot(): {
    readonly activeCancellations: number;
    readonly activeInputs: number;
    readonly inputKeys: number;
    readonly subscriptionActive: boolean;
  } {
    return Object.freeze({
      activeCancellations: this.cancellations.size,
      activeInputs: [...this.inputs.values()].filter(
        (operation) => operation.outcome === 'pending' && !operation.retired
      ).length,
      inputKeys: this.inputs.size,
      subscriptionActive: this.subscription !== undefined,
    });
  }

  private async fulfillInput(
    taskId: string,
    inputKey: string,
    request: ElicitRequest
  ): Promise<void> {
    const identity = inputIdentity(taskId, inputKey);
    const fingerprint = canonicalJson(request);
    let operation = this.inputs.get(identity);
    if (operation?.retired && operation.outcome !== 'unknown') {
      // A superseded or withdrawn request that was never possibly delivered:
      // re-requesting the key starts a fresh operation. The retired one was
      // already aborted and settles on its own. An unknown delivery stays fenced.
      this.inputs.delete(identity);
      operation = undefined;
    }
    if (operation) {
      if (operation.fingerprint !== fingerprint) {
        throw new Error(
          `MCP task "${taskId}" reused input key "${inputKey}" for a different request.`
        );
      }
    } else {
      const controller = new AbortController();
      const decision = this.resolveInput(taskId, inputKey, request, controller.signal);
      const acknowledged = Promise.withResolvers<void>();
      void acknowledged.promise.catch(() => undefined);
      const created: InputOperation = {
        acknowledged,
        controller,
        decision,
        delivery: undefined,
        fingerprint,
        inputKey,
        outcome: 'pending',
        retired: false,
        taskId,
      };
      operation = created;
      this.inputs.set(identity, operation);
      void decision.catch(() => undefined);
    }
    if (operation.outcome === 'acknowledged') {
      return;
    }
    if (operation.outcome === 'unknown') {
      throw new McpTaskInputDeliveryUnknownError(taskId, inputKey);
    }
    if (operation.delivery) {
      return await operation.delivery;
    }
    let delivery: Promise<void>;
    delivery = this.deliverInput(operation)
      .catch((error: unknown) => {
        // A withdrawal by this coordinator's own cancel() finishes the
        // observation; cancel() reports the cancellation outcome. Decide on
        // our own state, not the error: a transport's abort listener can
        // reject an in-flight tasks/update first with its own error.
        const { signal } = operation.controller;
        if (!(signal.aborted && signal.reason instanceof McpTaskInputWithdrawnError)) {
          throw error;
        }
      })
      .finally(() => {
        if (operation.delivery === delivery) {
          operation.delivery = undefined;
        }
      });
    operation.delivery = delivery;
    void delivery.catch(() => undefined);
    return await delivery;
  }

  private async resolveInput(
    taskId: string,
    inputKey: string,
    request: ElicitRequest,
    inputSignal: AbortSignal
  ): Promise<ElicitResult> {
    const taskController = this.taskControllers.get(taskId);
    if (!taskController) {
      throw new Error(`MCP task "${taskId}" has no live interaction scope.`);
    }
    const signal = AbortSignal.any([this.controller.signal, taskController.signal, inputSignal]);
    return await raceAbort(
      fulfillMcpElicitationRequest(this.elicitation, request, {
        ...this.scope,
        inputKey,
        requestId: inputKey,
        serverName: this.scope.serverId,
        signal,
        taskId,
      }),
      signal
    );
  }

  private async deliverInput(operation: InputOperation): Promise<void> {
    const { controller, decision, inputKey, taskId } = operation;
    const taskController = this.taskControllers.get(taskId);
    if (!taskController) {
      throw new Error(`MCP task "${taskId}" has no live interaction scope.`);
    }
    const signal = AbortSignal.any([
      this.controller.signal,
      taskController.signal,
      controller.signal,
    ]);
    const response = await raceAbort(decision, signal);
    const params = parseMcpUpdateTaskParams({ inputResponses: { [inputKey]: response }, taskId });
    try {
      await raceAbort(
        this.client.requestExtension(MCP_TASKS_UPDATE_REQUEST_CONTRACT, params, { signal }),
        signal
      );
    } catch (error) {
      // Once dispatched, only the ack proves the outcome. An error response, a
      // lost response, a transport failure, a timeout or an abort may all follow
      // an application, and the pinned spec guarantees no-application for none
      // of them, so the key is fenced as unknown and the original error rethrown.
      operation.outcome = 'unknown';
      operation.acknowledged.reject(new McpTaskInputDeliveryUnknownError(taskId, inputKey));
      throw error;
    }
    operation.outcome = 'acknowledged';
    operation.acknowledged.resolve();
  }

  private async runCancellation(
    taskId: string,
    terminal: Promise<'cancelled' | 'completed' | 'failed'>
  ): Promise<McpTaskCancellationResult> {
    const signal = this.controller.signal;
    await raceAbort(
      this.client.requestExtension(
        MCP_TASKS_CANCEL_REQUEST_CONTRACT,
        parseMcpCancelTaskParams({ taskId }),
        { signal }
      ),
      signal
    );
    const status = await raceAbort(terminal, signal);
    if (status !== 'cancelled') {
      throw new McpTaskCancellationOutcomeError(taskId, status);
    }
    return this.cancellationResult(taskId);
  }

  private cancellationResult(taskId: string): McpTaskCancellationResult {
    return Object.freeze({ ...this.scope, status: 'cancelled', taskId });
  }

  private releaseTaskInputs(taskId: string): void {
    for (const [identity, operation] of this.inputs) {
      if (operation.taskId !== taskId) {
        continue;
      }
      void Promise.allSettled([
        operation.decision,
        ...(operation.delivery ? [operation.delivery] : []),
      ]).then(() => {
        this.inputs.delete(identity);
      });
    }
  }

  private retireSupersededInputs(taskId: string, currentInputKeys: ReadonlySet<string>): void {
    for (const operation of this.inputs.values()) {
      if (
        operation.taskId !== taskId ||
        operation.retired ||
        currentInputKeys.has(operation.inputKey)
      ) {
        continue;
      }
      operation.retired = true;
      const superseded = new Error(`MCP task "${taskId}" input request was superseded.`);
      operation.acknowledged.reject(superseded);
      operation.controller.abort(superseded);
    }
  }

  private withdrawInputs(taskId: string): void {
    for (const operation of this.inputs.values()) {
      if (operation.taskId !== taskId || operation.outcome !== 'pending' || operation.retired) {
        continue;
      }
      operation.retired = true;
      const withdrawn = new McpTaskInputWithdrawnError(taskId, operation.inputKey);
      operation.acknowledged.reject(withdrawn);
      operation.controller.abort(withdrawn);
    }
  }

  private recordObservationFailure(taskId: string, error: unknown): void {
    if (!this.taskIds.has(taskId)) {
      throw new Error(`MCP task observation failure is outside the owned task set: "${taskId}".`);
    }
    this.observationFailures.set(taskId, error);
    this.cancellations.get(taskId)?.terminal.reject(error);
    this.taskControllers.get(taskId)?.abort(error);
    this.taskControllers.delete(taskId);
    this.releaseTaskInputs(taskId);
  }

  private recordSubscriptionClosure(
    subscription: McpTasksNotificationLease,
    error?: unknown
  ): void {
    if (this.subscription !== subscription) {
      return;
    }
    this.subscription = undefined;
    this.notificationTaskIds.clear();
    this.notificationError =
      error ?? new Error('MCP task notification subscription closed unexpectedly.');
  }

  private async finishClose(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = undefined;
    this.releaseObservationConsumer?.();
    this.releaseObservationConsumer = undefined;
    const subscriptionResult = subscription ? await Promise.allSettled([subscription.close()]) : [];
    await Promise.allSettled([
      ...[...this.inputs.values()].flatMap((operation) => [
        operation.decision,
        ...(operation.delivery ? [operation.delivery] : []),
      ]),
      ...[...this.cancellations.values()].map(({ promise }) => promise),
    ]);
    for (const operation of this.inputs.values()) {
      operation.acknowledged.reject(new Error('MCP task interaction closed.'));
    }
    this.cancellations.clear();
    this.inputs.clear();
    this.notificationTaskIds.clear();
    this.observationFailures.clear();
    this.statuses.clear();
    this.taskControllers.clear();
    this.taskIds.clear();
    this.started = false;
    const failures = subscriptionResult.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to close MCP task interaction resources.');
    }
  }

  private requireOpen(): void {
    if (this.controller.signal.aborted) {
      throw abortReason(this.controller.signal);
    }
  }
}
