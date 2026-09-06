import { expect } from 'vitest';

interface TestMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

type TestMessageListener = (event: TestMessageEvent) => void;

export class TestMessageTarget {
  readonly listeners = new Set<TestMessageListener>();

  addEventListener(type: 'message', listener: TestMessageListener): void {
    expect(type).toBe('message');
    this.listeners.add(listener);
  }

  dispatch(source: unknown, data: unknown, origin = 'null'): void {
    for (const listener of [...this.listeners]) {
      listener({ data, origin, source });
    }
  }

  removeEventListener(type: 'message', listener: TestMessageListener): void {
    expect(type).toBe('message');
    this.listeners.delete(listener);
  }
}

export class TestFrame {
  onPost: (() => void) | undefined;
  readonly sent: Array<{ readonly message: unknown; readonly targetOrigin: string }> = [];
  throwOnPost: Error | undefined;

  postMessage(message: unknown, targetOrigin: string): void {
    this.onPost?.();
    if (this.throwOnPost !== undefined) {
      throw this.throwOnPost;
    }
    this.sent.push({ message, targetOrigin });
  }
}

export const INITIALIZE = Object.freeze({
  id: 'initialize',
  jsonrpc: '2.0',
  method: 'ui/initialize',
  params: {
    appCapabilities: {},
    appInfo: { name: 'Verifier', version: '1.0.0' },
    protocolVersion: '2026-01-26',
  },
});

export const INITIALIZE_RESULT = Object.freeze({
  hostCapabilities: Object.freeze({}),
  hostContext: Object.freeze({ platform: 'desktop' }),
  hostInfo: Object.freeze({ name: 'Brainstrike', version: '1.0.0' }),
  protocolVersion: '2026-01-26',
});

export const INITIALIZED = Object.freeze({
  jsonrpc: '2.0',
  method: 'ui/notifications/initialized',
  params: {},
});
