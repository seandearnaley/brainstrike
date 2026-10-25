import { act as testingLibraryAct } from '@testing-library/react';
import { TestRunner, vi } from 'vitest';

/**
 * React Testing Library's `act`, whose async scope ends with the test that
 * opened it.
 *
 * React keeps an act scope open until its callback settles, and every render
 * inside an open scope waits for the scope to end. A test that times out
 * inside `await act(async () => ...)` leaves its callback running (an input
 * event the browser has not delivered, a `waitFor`), so every later render in
 * the file would wait on a test that is already over. Vitest aborts the test's
 * signal when it times out, and the scope ends there.
 */
export function act<T>(callback: () => Promise<T>): Promise<T>;
export function act(callback: () => void): void;
export function act<T>(callback: () => T | Promise<T>): Promise<T> {
  return actUntil(TestRunner.getCurrentTest()?.context.signal, callback);
}

/**
 * `act` whose async scope ends when `signal` aborts. A scope opened after the
 * abort (a failed test's cleanup) runs to its end.
 */
export function actUntil<T>(
  signal: AbortSignal | undefined,
  callback: () => T | Promise<T>
): Promise<T> {
  return testingLibraryAct(() => {
    const result = callback();
    return signal === undefined || signal.aborted || !(result instanceof Promise)
      ? result
      : endedBy(signal, result);
  });
}

function endedBy<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Testing Library's `waitFor` for a test on Vitest's fake timers, which
 * Testing Library's own `waitFor` cannot advance. As there, React does not
 * expect act while the condition is polled, and the work the poll set off
 * settles before act is expected again.
 */
export async function waitForOnFakeTimers<T>(callback: () => T | Promise<T>): Promise<T> {
  const expected = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
  try {
    const result = await vi.waitFor(callback);
    await (vi.isFakeTimers()
      ? vi.advanceTimersByTimeAsync(0)
      : new Promise((resolve) => setTimeout(resolve, 0)));
    return result;
  } finally {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', expected);
  }
}
