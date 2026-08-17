import { useMemo, useSyncExternalStore } from 'react';
import { createReleaseManifestClient } from './release-client';
import type { ReleaseManifest } from './release-manifest';

export type ReleaseManifestState =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'error' }
  | {
      readonly manifest: ReleaseManifest;
      readonly status: 'ready';
      readonly warning?: string | undefined;
    };

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

export function manifestRequestFailureState(
  currentState: ReleaseManifestState,
  error: unknown,
  showLoading: boolean
): ReleaseManifestState {
  const message = errorMessage(error);
  if (!showLoading && currentState.status === 'ready') {
    return { ...currentState, warning: `Release refresh failed: ${message}` };
  }
  return { error: message, status: 'error' };
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
        publish(manifestRequestFailureState(releaseState, error, showLoading));
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
  runRequest(client.retry(), releaseState.status !== 'ready');
}

function refresh(): void {
  if (releaseState.status !== 'ready') {
    return;
  }
  // retry() invalidates before loading, so opening the chooser always performs
  // the network revalidation RELEASES.md documents. Plain load() would
  // short-circuit inside the cache TTL and republish a clean ready state —
  // silently clearing a prior refresh-failure warning without any fetch
  // having confirmed the data.
  runRequest(client.retry(), false);
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
