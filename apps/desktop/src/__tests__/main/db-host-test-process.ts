import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export interface PostedMessage {
  readonly id: string;
  readonly kind: 'request';
  readonly request: {
    readonly kind: string;
    readonly params?: readonly unknown[];
    readonly payload?: {
      readonly params?: readonly unknown[] | null;
      readonly query?: string;
    };
    readonly sql?: string;
    readonly transactionId?: string;
  };
}

export class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn((message: PostedMessage) => {
    this.messages.push(message);
  });
  readonly messages: PostedMessage[] = [];
  pid: number | undefined = 42;

  exitOnKill(code = 0): this {
    this.kill.mockImplementation(() => {
      queueMicrotask(() => this.emit('exit', code));
      return true;
    });
    return this;
  }

  reply(message: PostedMessage, result: unknown): void {
    this.emit('message', {
      id: message.id,
      kind: 'response',
      ok: true,
      result,
    });
  }

  reject(message: PostedMessage, error: string): void {
    this.emit('message', {
      error: { message: error },
      id: message.id,
      kind: 'response',
      ok: false,
    });
  }
}
