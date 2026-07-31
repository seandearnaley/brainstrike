import { useSyncExternalStore } from 'react';
import { parseReleaseManifest, type ReleaseManifest } from './release-manifest';

export type ReleaseManifestState =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'error' }
  | { readonly manifest: ReleaseManifest; readonly status: 'ready' };

const listeners = new Set<() => void>();
let requestStarted = false;
let releaseState: ReleaseManifestState = { status: 'loading' };

function publish(nextState: ReleaseManifestState): void {
  releaseState = nextState;
  for (const listener of listeners) {
    listener();
  }
}

function startManifestRequest(): void {
  if (requestStarted) {
    return;
  }
  requestStarted = true;
  void fetch('/release-manifest.json', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Release manifest request failed with HTTP ${response.status}.`);
      }
      return response.json() as Promise<unknown>;
    })
    .then((value) => {
      publish({ manifest: parseReleaseManifest(value), status: 'ready' });
    })
    .catch((error: unknown) => {
      publish({ error: error instanceof Error ? error.message : String(error), status: 'error' });
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startManifestRequest();
  return () => listeners.delete(listener);
}

function getSnapshot(): ReleaseManifestState {
  return releaseState;
}

export function useReleaseManifest(): ReleaseManifestState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
