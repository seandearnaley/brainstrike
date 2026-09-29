import { type MockInstance, vi } from 'vitest';

export type CapturedSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';

const CAPTURED_SIGNALS: ReadonlySet<string | symbol> = new Set<CapturedSignal>([
  'SIGHUP',
  'SIGINT',
  'SIGTERM',
]);

type ProcessOn = (event: string | symbol, listener: (...args: unknown[]) => void) => NodeJS.Process;

/**
 * Captures the SIGINT/SIGTERM/SIGHUP listeners a module registers on `process`
 * instead of installing them. A test then calls a handler directly: a real
 * signal must never reach the test runner's own process. Every other `process.on`
 * registration passes through to the real one.
 */
export function captureProcessSignalHandlers(): {
  readonly handlers: Map<string, ((...args: unknown[]) => void)[]>;
  readonly restore: () => void;
} {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const realOn = process.on.bind(process) as ProcessOn;
  const spy = vi.spyOn(process, 'on') as unknown as MockInstance<ProcessOn>;
  spy.mockImplementation((event, listener) => {
    if (!CAPTURED_SIGNALS.has(event)) {
      return realOn(event, listener);
    }
    handlers.set(String(event), [...(handlers.get(String(event)) ?? []), listener]);
    return process;
  });
  return { handlers, restore: () => spy.mockRestore() };
}
