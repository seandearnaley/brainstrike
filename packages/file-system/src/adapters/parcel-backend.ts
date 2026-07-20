// BST-568: explicit @parcel/watcher backend selection + lazy binding load.
//
// Invariants (do not relitigate — see docs/agents/research/bst-568-parcel-watcher-spike.md):
// - Backend is chosen explicitly per OS; an unsupported platform throws a
//   typed error rather than letting the native layer pick a default.
// - The native binding loads lazily (first watch, not module import) and a
//   load failure throws with the underlying cause — no silent fallback to
//   another engine at this layer.
export type ParcelBackendName = 'fs-events' | 'inotify' | 'windows';

export type ParcelWatcherModule = typeof import('@parcel/watcher');

export class ParcelWatcherUnavailableError extends Error {
  readonly code: 'binding-load-failed' | 'unsupported-platform';

  constructor(
    code: 'binding-load-failed' | 'unsupported-platform',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ParcelWatcherUnavailableError';
    this.code = code;
  }
}

const BACKEND_BY_PLATFORM: Partial<Record<NodeJS.Platform, ParcelBackendName>> = {
  darwin: 'fs-events',
  linux: 'inotify',
  win32: 'windows',
};

export function selectParcelBackend(
  platform: NodeJS.Platform = process.platform
): ParcelBackendName {
  const backend = BACKEND_BY_PLATFORM[platform];
  if (!backend) {
    throw new ParcelWatcherUnavailableError(
      'unsupported-platform',
      `No @parcel/watcher backend for platform ${platform}`
    );
  }
  return backend;
}

let cachedLoad: Promise<ParcelWatcherModule> | null = null;

export function loadParcelWatcher(): Promise<ParcelWatcherModule> {
  if (!cachedLoad) {
    // Binding presence cannot change within a process, so failures cache too.
    cachedLoad = import('@parcel/watcher').catch((error: unknown) => {
      throw new ParcelWatcherUnavailableError(
        'binding-load-failed',
        'Failed to load the @parcel/watcher native binding',
        { cause: error }
      );
    });
  }
  return cachedLoad;
}
