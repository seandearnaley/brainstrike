export interface ConsoleErrorProbe {
  readonly calls: readonly (readonly unknown[])[];
  clear: () => void;
  restore: () => void;
}

export function captureConsoleError(): ConsoleErrorProbe {
  const calls: unknown[][] = [];
  // biome-ignore lint/suspicious/noConsole: this test probe must preserve the active error sink
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    calls.push(args);
    originalConsoleError(...args);
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
