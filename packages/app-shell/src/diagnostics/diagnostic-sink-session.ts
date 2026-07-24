/**
 * Non-component diagnostic-sink constants/helpers, split out of
 * `diagnostic-sink-bridge.tsx` so that module can export components only
 * (react-doctor `only-export-components` — Fast Refresh boundary).
 */

export const DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink';

let sessionId: string | null = null;

export function getDiagnosticSessionId(): string {
  sessionId ??= crypto.randomUUID();
  return sessionId;
}
