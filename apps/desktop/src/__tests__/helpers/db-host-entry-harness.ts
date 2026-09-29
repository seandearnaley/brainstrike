import { vi } from 'vitest';
import { type CapturedSignal, captureProcessSignalHandlers } from './process-signal-capture';

interface ParentPortMock {
  readonly on: (event: 'message', listener: (message: unknown) => void) => ParentPortMock;
  readonly postMessage: ReturnType<typeof vi.fn>;
}

export interface BootedHost {
  readonly exitCodes: (number | string | null | undefined)[];
  readonly parentPort: ParentPortMock;
  readonly send: (id: string, request: { readonly kind: string; readonly sql?: string }) => void;
  readonly signal: (signal: CapturedSignal) => void;
  readonly signalHandlers: Map<string, ((...args: unknown[]) => void)[]>;
}

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

export function restoreParentPort(): void {
  Object.defineProperty(
    process,
    'parentPort',
    originalParentPortDescriptor ?? { configurable: true, value: undefined, writable: true }
  );
}

/**
 * Imports the real DB host entry with a fake parent port, captured signal handlers and a stubbed
 * `process.exit`. What the entry imports stays whatever the calling test file mocked.
 *
 * The `process.on`, `process.removeAllListeners`, `process.listenerCount` and `process.exit` spies
 * are only undone by the caller's `vi.restoreAllMocks()` (call it in `afterEach`), and the
 * `parentPort` by `restoreParentPort()`.
 */
export async function bootHost(): Promise<BootedHost> {
  const listeners: ((message: unknown) => void)[] = [];
  const parentPort: ParentPortMock = {
    on: vi.fn((event: 'message', listener: (message: unknown) => void) => {
      if (event === 'message') {
        listeners.push(listener);
      }
      return parentPort;
    }),
    postMessage: vi.fn(),
  };
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: parentPort,
    writable: true,
  });
  const { handlers } = captureProcessSignalHandlers();
  const exitCodes: BootedHost['exitCodes'] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    exitCodes.push(code);
    return undefined as never;
  }) as typeof process.exit);
  await import('../../db-host-entry');
  return {
    exitCodes,
    parentPort,
    send: (id, request) => {
      listeners[0]?.({ data: { id, kind: 'request', request } });
    },
    signal: (signal) => {
      for (const handler of handlers.get(signal) ?? []) {
        handler(signal);
      }
    },
    signalHandlers: handlers,
  };
}

export function posted(host: BootedHost): Record<string, unknown>[] {
  return host.parentPort.postMessage.mock.calls.map(
    ([message]) => message as Record<string, unknown>
  );
}

export function responsesFor(host: BootedHost, id: string): Record<string, unknown>[] {
  return posted(host).filter((message) => message['kind'] === 'response' && message['id'] === id);
}

export function lifecycleStates(host: BootedHost): string[] {
  return posted(host)
    .filter((message) => message['kind'] === 'lifecycle')
    .map((message) => `${message['state']}:${message['reason']}`);
}

/**
 * Where the first posted response for `id` sits in vitest's global call order, to compare with
 * `exitCallOrder()`: a reply queued after `process.exit` was called would never be sent.
 */
export function responseCallOrder(host: BootedHost, id: string): number | undefined {
  const index = posted(host).findIndex(
    (message) => message['kind'] === 'response' && message['id'] === id
  );
  return index === -1 ? undefined : host.parentPort.postMessage.mock.invocationCallOrder[index];
}

/** Where the first (stubbed) `process.exit` call sits in vitest's global call order. */
export function exitCallOrder(): number | undefined {
  return vi.mocked(process.exit).mock.invocationCallOrder[0];
}
