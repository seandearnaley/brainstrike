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

interface InputOperation {
  acknowledged: boolean;
  readonly decision: Promise<ElicitResult>;
  decisionSettled: boolean;
  delivery: Promise<void> | undefined;
  readonly fingerprint: string;
  readonly taskId: string;
}

interface CancellationOperation {
  readonly promise: Promise<McpTaskCancellationResult>;
  settled: boolean;
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
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
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
  private readonly scope: McpTaskScope;
  private readonly statuses = new Map<string, TaskStatus>();
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly taskIds = new Set<string>();
  private closePromise: Promise<void> | undefined;
  private started = false;
  private subscription: McpTasksNotificationLease | undefined;

  constructor(options: McpTaskInteractionOptions) {
    this.client = options.client;
    this.elicitation = options.elicitation;
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
    this.started = true;
    for (const taskId of uniqueTaskIds) {
      this.taskIds.add(taskId);
      this.taskControllers.set(taskId, new AbortController());
    }
    try {
      const subscription = await raceAbort(
        this.client.listenTasks(taskIds, (task) => this.observe(task), {
          signal: this.controller.signal,
        }),
        this.controller.signal
      );
      if (this.controller.signal.aborted) {
        await subscription.close();
        throw abortReason(this.controller.signal);
      }
      this.subscription = subscription;
      this.watchSubscription(subscription);
    } catch (error) {
      this.started = false;
      this.taskControllers.clear();
      this.taskIds.clear();
      throw error;
    }
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
    if (task.status !== 'input_required') {
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
    let operation: CancellationOperation;
    const promise = this.runCancellation(taskId, terminal.promise).finally(() => {
      operation.settled = true;
    });
    operation = { promise, settled: false, terminal };
    this.cancellations.set(taskId, operation);
    void promise.catch(() => undefined);
    return promise;
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
      activeCancellations: [...this.cancellations.values()].filter(
        (operation) => !operation.settled
      ).length,
      activeInputs: [...this.inputs.values()].filter(
        (operation) => !(operation.decisionSettled && operation.delivery === undefined)
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
    if (operation) {
      if (operation.fingerprint !== fingerprint) {
        throw new Error(
          `MCP task "${taskId}" reused input key "${inputKey}" for a different request.`
        );
      }
    } else {
      let created: InputOperation;
      const decision = this.resolveInput(taskId, inputKey, request).finally(() => {
        created.decisionSettled = true;
      });
      created = {
        acknowledged: false,
        decision,
        decisionSettled: false,
        delivery: undefined,
        fingerprint,
        taskId,
      };
      operation = created;
      this.inputs.set(identity, operation);
      void decision.catch(() => undefined);
    }
    if (operation.acknowledged) {
      return;
    }
    if (operation.delivery) {
      return await operation.delivery;
    }
    let delivery: Promise<void>;
    delivery = this.deliverInput(taskId, inputKey, operation.decision)
      .then(() => {
        operation.acknowledged = true;
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
    request: ElicitRequest
  ): Promise<ElicitResult> {
    const taskController = this.taskControllers.get(taskId);
    if (!taskController) {
      throw new Error(`MCP task "${taskId}" has no live interaction scope.`);
    }
    const signal = AbortSignal.any([this.controller.signal, taskController.signal]);
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

  private async deliverInput(
    taskId: string,
    inputKey: string,
    decision: Promise<ElicitResult>
  ): Promise<void> {
    const taskController = this.taskControllers.get(taskId);
    if (!taskController) {
      throw new Error(`MCP task "${taskId}" has no live interaction scope.`);
    }
    const signal = AbortSignal.any([this.controller.signal, taskController.signal]);
    const response = await raceAbort(decision, signal);
    await raceAbort(
      this.client.requestExtension(
        MCP_TASKS_UPDATE_REQUEST_CONTRACT,
        parseMcpUpdateTaskParams({ inputResponses: { [inputKey]: response }, taskId }),
        { signal }
      ),
      signal
    );
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

  private watchSubscription(subscription: McpTasksNotificationLease): void {
    void subscription.closed.then(
      () => this.handleSubscriptionClosed(subscription),
      () => this.handleSubscriptionClosed(subscription)
    );
  }

  private handleSubscriptionClosed(subscription: McpTasksNotificationLease): void {
    if (this.subscription !== subscription) {
      return;
    }
    this.subscription = undefined;
    this.controller.abort(new Error('MCP task notification subscription closed unexpectedly.'));
  }

  private releaseTaskInputs(taskId: string): void {
    for (const [identity, operation] of this.inputs) {
      if (operation.taskId !== taskId) {
        continue;
      }
      if (operation.decisionSettled && operation.delivery === undefined) {
        this.inputs.delete(identity);
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

  private async finishClose(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = undefined;
    const subscriptionResult = subscription ? await Promise.allSettled([subscription.close()]) : [];
    await Promise.allSettled([
      ...[...this.inputs.values()].flatMap((operation) => [
        operation.decision,
        ...(operation.delivery ? [operation.delivery] : []),
      ]),
      ...[...this.cancellations.values()].map(({ promise }) => promise),
    ]);
    this.cancellations.clear();
    this.inputs.clear();
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
