const originalWarn = console.warn;
const originalError = console.error;

console.warn = (...args: Parameters<typeof console.warn>) => {
  const [message] = args;
  if (typeof message === 'string' && message.includes('[token-utils]')) {
    return;
  }

  originalWarn(...args);
};

console.error = (...args: Parameters<typeof console.error>) => {
  const [firstArg] = args;
  const matchesKnownBoundaryLog =
    (typeof firstArg === 'string' &&
      (firstArg.includes('The above error occurred in the <') ||
        firstArg.startsWith('FileContentError:') ||
        firstArg.startsWith('Error: Copy error') ||
        firstArg.startsWith('Error: Unknown') ||
        firstArg.startsWith('Toggle error'))) ||
    (firstArg instanceof Error &&
      (firstArg.message.startsWith('FileContentError:') ||
        firstArg.message.startsWith('Copy error') ||
        firstArg.message.startsWith('Unknown') ||
        firstArg.message.startsWith('Toggle error')));

  if (matchesKnownBoundaryLog) {
    return;
  }

  originalError(...args);
};
