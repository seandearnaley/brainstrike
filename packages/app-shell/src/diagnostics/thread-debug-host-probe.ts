import {
  type BoundaryTransport,
  callBoundary,
} from '@brainstrike/assistant-contract/boundary-result';
/** The desktop host readers the thread debug pack consumes at build time. */
export interface ThreadDebugHostProbe {
  /** The profile's Crashpad minidumps, newest first (BST-2351). */
  listCrashDumps(): Promise<unknown>;
  /** Main's retained diagnostic log, the records the status bar counts; newest first. */
  queryEvents(filter: { readonly limit: number }): Promise<unknown>;
  readMainLogWindow(request: { readonly since: string; readonly until: string }): Promise<unknown>;
  readProcessCounters(): Promise<unknown>;
}

/**
 * Capability probe (never `isElectron()`): a web build, or a preload that lacks
 * any of the readers, yields null, and the pack names that as the reason host
 * evidence is absent.
 */
export function readThreadDebugHostProbe(): ThreadDebugHostProbe | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'listCrashDumps' in candidate &&
    typeof candidate.listCrashDumps === 'function' &&
    'queryEvents' in candidate &&
    typeof candidate.queryEvents === 'function' &&
    'readMainLogWindow' in candidate &&
    typeof candidate.readMainLogWindow === 'function' &&
    'readProcessCounters' in candidate &&
    typeof candidate.readProcessCounters === 'function'
  ) {
    const transport = candidate as BoundaryTransport<
      Pick<ThreadDebugHostProbe, 'listCrashDumps' | 'readMainLogWindow' | 'readProcessCounters'>
    > &
      Pick<ThreadDebugHostProbe, 'queryEvents'>;
    return {
      listCrashDumps: () => callBoundary(() => transport.listCrashDumps()),
      // Answers its events, or rejects, as the failed-run debug bundle reads it.
      queryEvents: (filter) => transport.queryEvents(filter),
      readMainLogWindow: (request) => callBoundary(() => transport.readMainLogWindow(request)),
      readProcessCounters: () => callBoundary(() => transport.readProcessCounters()),
    };
  }
  return null;
}
