/* biome-ignore-all lint/suspicious/noConsole: this test-only probe must observe and restore console.error */

export const REACT_ACT_WARNING_PROBE =
  'An update to Probe inside a test was not wrapped in act(...). When testing, code that causes React state updates should be wrapped into act(...).';

export interface ConsoleErrorProbe {
  readonly calls: readonly (readonly unknown[])[];
  clear: () => void;
  restore: () => void;
}

export function captureConsoleError(): ConsoleErrorProbe {
  const calls: unknown[][] = [];
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  return {
    calls,
    clear: () => {
      calls.length = 0;
    },
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}
