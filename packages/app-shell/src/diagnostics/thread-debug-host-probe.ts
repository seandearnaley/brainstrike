/** The two desktop host readers the thread debug pack consumes at build time. */
export interface ThreadDebugHostProbe {
  readMainLogWindow(request: { readonly since: string; readonly until: string }): Promise<unknown>;
  readProcessCounters(): Promise<unknown>;
}

/**
 * Capability probe (never `isElectron()`): a web build, or a preload that lacks
 * either reader, yields null, and the pack names that as the reason host
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
    'readMainLogWindow' in candidate &&
    typeof candidate.readMainLogWindow === 'function' &&
    'readProcessCounters' in candidate &&
    typeof candidate.readProcessCounters === 'function'
  ) {
    return candidate as ThreadDebugHostProbe;
  }
  return null;
}
