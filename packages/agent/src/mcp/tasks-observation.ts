import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';

export interface McpTaskObservationConsumer {
  readonly fail: (taskId: string, error: unknown) => void;
  readonly observe: (task: GetTaskResult) => Promise<void> | void;
}

export interface McpTaskPollAuthority {
  readonly wake: (taskId: string) => void;
}

export interface McpTaskObservationPortOptions {
  /**
   * Receives every error a consumer throws while observing a task or a
   * failure. Consumer errors are reported here, never thrown back into the
   * authoritative poller, so a misbehaving or narrower-scoped consumer cannot
   * settle a tracked task.
   */
  readonly onConsumerError: (taskId: string, error: unknown) => void;
}

export class McpTaskObservationError extends Error {
  constructor(
    readonly taskId: string,
    readonly failures: number,
    cause: unknown
  ) {
    super(`MCP task "${taskId}" observation failed after ${failures} bounded attempts.`, { cause });
    this.name = 'McpTaskObservationError';
  }
}

/**
 * Neutral seam between the authoritative poller and the optional interaction
 * consumer. Publication is advisory: with no consumer attached it is a no-op
 * (polling stays authoritative), and consumer errors go to
 * `onConsumerError`. Only `requestPoll` is strict, because a wake with no
 * polling authority is a wiring defect.
 */
export class McpTaskObservationPort {
  private authority: McpTaskPollAuthority | undefined;
  private consumer: McpTaskObservationConsumer | undefined;
  private readonly onConsumerError: (taskId: string, error: unknown) => void;

  constructor(options: McpTaskObservationPortOptions) {
    this.onConsumerError = options.onConsumerError;
  }

  attachAuthority(authority: McpTaskPollAuthority): () => void {
    if (this.authority) {
      throw new Error('MCP task observation port already has a polling authority.');
    }
    this.authority = authority;
    return () => {
      if (this.authority === authority) {
        this.authority = undefined;
      }
    };
  }

  subscribe(consumer: McpTaskObservationConsumer): () => void {
    if (this.consumer) {
      throw new Error('MCP task observation port already has an interaction consumer.');
    }
    this.consumer = consumer;
    return () => {
      if (this.consumer === consumer) {
        this.consumer = undefined;
      }
    };
  }

  requestPoll(taskId: string): void {
    if (!this.authority) {
      throw new Error('MCP task observation port has no polling authority.');
    }
    this.authority.wake(taskId);
  }

  async publish(task: GetTaskResult): Promise<void> {
    const consumer = this.consumer;
    if (!consumer) {
      return;
    }
    try {
      await consumer.observe(task);
    } catch (error: unknown) {
      this.onConsumerError(task.taskId, error);
    }
  }

  publishFailure(taskId: string, error: unknown): void {
    const consumer = this.consumer;
    if (!consumer) {
      return;
    }
    try {
      consumer.fail(taskId, error);
    } catch (consumerError: unknown) {
      this.onConsumerError(taskId, consumerError);
    }
  }
}
