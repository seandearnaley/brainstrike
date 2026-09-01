import type { GetTaskResult } from '@brainstrike/mcp-tasks-extension';

export interface McpTaskObservationConsumer {
  readonly fail: (taskId: string, error: unknown) => void;
  readonly observe: (task: GetTaskResult) => Promise<void> | void;
}

export interface McpTaskPollAuthority {
  readonly wake: (taskId: string) => void;
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

export class McpTaskObservationPort {
  private authority: McpTaskPollAuthority | undefined;
  private consumer: McpTaskObservationConsumer | undefined;

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
    if (!this.consumer) {
      throw new Error('MCP task observation port has no interaction consumer.');
    }
    await this.consumer.observe(task);
  }

  publishFailure(taskId: string, error: unknown): void {
    if (!this.consumer) {
      throw new Error('MCP task observation port has no interaction consumer.');
    }
    this.consumer.fail(taskId, error);
  }
}
