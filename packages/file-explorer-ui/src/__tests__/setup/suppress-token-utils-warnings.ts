import * as loggerModule from '@brainstrike/logging';
import { beforeEach, vi } from 'vitest';

const originalWarn = console.warn;
const originalError = console.error;
const expectedErrorMessagePatterns = [
  'Token cache worker warmup failed after',
  'TokenCacheProvider: failed to create worker pool',
];
const expectedInfoMessagePatterns = [
  'loadRoot running - will reinitialize worker',
  'loadRoot completed - handle map built',
  'loadRoot joined existing in-flight request',
  'loadSpecificPaths starting',
  'buildHandleMap complete',
];
const instrumentedStreams = new WeakSet<NodeJS.WriteStream>();

function shouldSuppressStreamChunk(chunk: unknown): boolean {
  const renderedChunk =
    typeof chunk === 'string'
      ? chunk
      : chunk instanceof Uint8Array
        ? new TextDecoder().decode(chunk)
        : String(chunk ?? '');

  return (
    expectedErrorMessagePatterns.some((pattern) => renderedChunk.includes(pattern)) ||
    expectedInfoMessagePatterns.some((pattern) => renderedChunk.includes(pattern))
  );
}

function installStreamFilter(stream: NodeJS.WriteStream): void {
  if (instrumentedStreams.has(stream)) {
    return;
  }

  const originalWrite = stream.write.bind(stream);
  instrumentedStreams.add(stream);
  stream.write = ((chunk: unknown, ...args: unknown[]) => {
    if (shouldSuppressStreamChunk(chunk)) {
      const callback = args.find((arg) => typeof arg === 'function');
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    }
    return originalWrite(chunk as never, ...(args as []));
  }) as typeof stream.write;
}

installStreamFilter(process.stdout);
installStreamFilter(process.stderr);

beforeEach(() => {
  const applySilentLoggerConsole = () => {
    loggerModule.configureLogger({ console: false });
  };

  applySilentLoggerConsole();
  const originalResetLogger = loggerModule.resetLogger;
  vi.spyOn(loggerModule, 'resetLogger').mockImplementation(() => {
    originalResetLogger();
    applySilentLoggerConsole();
  });
});

console.warn = (...args: Parameters<typeof console.warn>) => {
  const [message] = args;
  const renderedMessage = String(message ?? '');
  if (renderedMessage.includes('[token-utils]')) {
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
        firstArg.startsWith('Toggle error') ||
        expectedErrorMessagePatterns.some((pattern) => firstArg.includes(pattern)))) ||
    (firstArg instanceof Error &&
      (firstArg.message.startsWith('FileContentError:') ||
        firstArg.message.startsWith('Copy error') ||
        firstArg.message.startsWith('Unknown') ||
        firstArg.message.startsWith('Toggle error') ||
        expectedErrorMessagePatterns.some((pattern) => firstArg.message.includes(pattern))));

  if (matchesKnownBoundaryLog) {
    return;
  }

  originalError(...args);
};
