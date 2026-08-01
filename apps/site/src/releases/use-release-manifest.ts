import { useMemo, useSyncExternalStore } from 'react';
import { createReleaseManifestClient } from './release-client';
import type { ReleaseManifest } from './release-manifest';

export type ReleaseManifestState =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'error' }
  | { readonly manifest: ReleaseManifest; readonly status: 'ready' };

export interface ReleaseManifestController {
  readonly refresh: () => void;
  readonly retry: () => void;
  readonly state: ReleaseManifestState;
}

const client = createReleaseManifestClient();
const listeners = new Set<() => void>();
let requestStarted = false;
let requestSequence = 0;
let releaseState: ReleaseManifestState = { status: 'loading' };

function publish(nextState: ReleaseManifestState): void {
  releaseState = nextState;
  for (const listener of listeners) {
    listener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runRequest(request: Promise<ReleaseManifest>, showLoading = true): void {
  requestStarted = true;
  requestSequence += 1;
  const sequence = requestSequence;
  if (showLoading) {
    publish({ status: 'loading' });
  }
  void request.then(
    (manifest) => {
      if (sequence === requestSequence) {
        publish({ manifest, status: 'ready' });
      }
    },
    (error: unknown) => {
      if (sequence === requestSequence) {
        publish({ error: errorMessage(error), status: 'error' });
      }
    }
  );
}

function startManifestRequest(): void {
  if (requestStarted) {
    return;
  }
  runRequest(client.load());
}

function retry(): void {
  runRequest(client.retry());
}

function refresh(): void {
  if (releaseState.status !== 'ready') {
    return;
  }
  runRequest(client.load(), false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startManifestRequest();
  return () => listeners.delete(listener);
}

function getSnapshot(): ReleaseManifestState {
  return releaseState;
}

export function useReleaseManifest(): ReleaseManifestController {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => ({ refresh, retry, state }), [state]);
}
