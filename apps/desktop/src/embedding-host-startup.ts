import type { EmbeddingHostStatus } from './embedding-host-shared';

/** Wait for the host's startup, or reject with the caller's abort reason first. */
export function waitForHostStartup(
  startup: Promise<EmbeddingHostStatus>,
  signal?: AbortSignal
): Promise<EmbeddingHostStatus> {
  if (!signal) {
    return startup;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    void startup.then(
      (status) => {
        signal.removeEventListener('abort', onAbort);
        resolve(status);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
