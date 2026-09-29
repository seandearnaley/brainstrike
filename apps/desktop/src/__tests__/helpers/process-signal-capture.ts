import { type MockInstance, vi } from 'vitest';

export type CapturedSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

const CAPTURED_SIGNALS: ReadonlySet<string | symbol | undefined> = new Set<CapturedSignal>([
  'SIGHUP',
  'SIGINT',
  'SIGTERM',
]);

type Listener = (...args: unknown[]) => void;
type ProcessOn = (event: string | symbol, listener: Listener) => NodeJS.Process;
type ProcessRemoveAll = (event?: string | symbol) => NodeJS.Process;
type ProcessListenerCount = (event: string | symbol) => number;

/**
 * Captures the SIGINT/SIGTERM/SIGHUP listeners a module registers on `process`
 * instead of installing them, and answers `listenerCount` / `removeAllListeners`
 * for those signals from the same capture. A test then calls a handler directly:
 * a real signal must never reach the test runner's own process, and its own
 * listeners must never be dropped. Every other event passes through to the real one.
 */
export function captureProcessSignalHandlers(): {
  readonly handlers: Map<string, Listener[]>;
  readonly restore: () => void;
} {
  const handlers = new Map<string, Listener[]>();
  const realOn = process.on.bind(process) as ProcessOn;
  const realRemoveAll = process.removeAllListeners.bind(process) as ProcessRemoveAll;
  const realListenerCount = process.listenerCount.bind(process) as ProcessListenerCount;
  const spies = [
    (vi.spyOn(process, 'on') as unknown as MockInstance<ProcessOn>).mockImplementation(
      (event, listener) => {
        if (!CAPTURED_SIGNALS.has(event)) {
          return realOn(event, listener);
        }
        handlers.set(String(event), [...(handlers.get(String(event)) ?? []), listener]);
        return process;
      }
    ),
    (
      vi.spyOn(process, 'removeAllListeners') as unknown as MockInstance<ProcessRemoveAll>
    ).mockImplementation((event) => {
      if (!CAPTURED_SIGNALS.has(event)) {
        return realRemoveAll(event);
      }
      handlers.delete(String(event));
      return process;
    }),
    (
      vi.spyOn(process, 'listenerCount') as unknown as MockInstance<ProcessListenerCount>
    ).mockImplementation((event) =>
      CAPTURED_SIGNALS.has(event)
        ? (handlers.get(String(event))?.length ?? 0)
        : realListenerCount(event)
    ),
  ];
  return {
    handlers,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}
