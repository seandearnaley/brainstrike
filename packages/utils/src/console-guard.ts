const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

let guardInstalled = false;

function createGuardedMethod(original: Console[ConsoleMethod]): Console[ConsoleMethod] {
  return function guardedConsoleMethod(this: Console, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch (error) {
      if (
        error instanceof RangeError &&
        typeof error.message === 'string' &&
        error.message.includes('Invalid array length')
      ) {
        return;
      }
      throw error;
    }
  };
}

export function installConsoleGuard(): void {
  if (guardInstalled) {
    return;
  }

  const globalConsole = typeof console === 'undefined' ? null : console;
  if (!globalConsole) {
    return;
  }

  for (const method of CONSOLE_METHODS) {
    const original = globalConsole[method];
    if (typeof original === 'function') {
      globalConsole[method] = createGuardedMethod(original);
    }
  }

  guardInstalled = true;
}
