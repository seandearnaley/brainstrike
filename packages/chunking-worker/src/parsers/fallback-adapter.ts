/**
 * Per-file fallback wrapper for parser adapters.
 *
 * Wraps a primary adapter (e.g., `oxcIpcAdapter`) so that any parse failure
 * silently falls through to a fallback adapter (e.g., `babelAdapter`) for
 * THAT FILE ONLY. The pipeline never crashes because of a parser bug —
 * worst-case is a single file gets parsed by the slower fallback path,
 * which is logged for telemetry.
 *
 * This is the safety net the PRD §7 aggressive rollout posture depends on.
 * Without it, "default oxc on for every Electron user" would be one bad
 * file away from a P0 outage. With it, the same situation produces a
 * telemetry signal and a perf regression on a few files.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §8
 */

import type { ParseOptions, ParserAdapter } from './types';

/**
 * Hook for telemetry. Default implementation logs a debug message; production
 * code can replace this via the `onFallback` constructor option to hook into
 * the project's telemetry pipeline (Phase 8 wires that).
 */
export type FallbackTelemetry = (event: {
  readonly primary: ParserAdapter['id'];
  readonly fallback: ParserAdapter['id'];
  readonly error: string;
}) => void;

const defaultTelemetry: FallbackTelemetry = (event) => {
  // biome-ignore lint/suspicious/noConsole: telemetry hook before Phase 8 wires real sink
  console.warn(
    `[chunking-parser] ${event.primary} failed, falling back to ${event.fallback}: ${event.error}`
  );
};

/**
 * Returns a `ParserAdapter` that tries `primary` first, falling back to
 * `fallback` on any error. The returned adapter takes the primary's `id` so
 * downstream code that introspects the id sees the *intended* adapter.
 */
function safeFireTelemetry(
  telemetry: FallbackTelemetry,
  event: { error: string; fallback: ParserAdapter['id']; primary: ParserAdapter['id'] }
): void {
  // Telemetry is best-effort: a throwing hook MUST NOT prevent the
  // fallback parse from running, otherwise a bad telemetry sink would
  // cascade into chunking-pipeline failures and defeat the whole point
  // of the fallback. We swallow telemetry errors and log a single
  // console.error so the misbehaving sink is visible without taking
  // the user's chunking job down.
  try {
    telemetry(event);
  } catch (telemetryError) {
    // biome-ignore lint/suspicious/noConsole: surface telemetry hook bugs without crashing fallback
    console.error('[chunking-parser] telemetry hook threw; suppressing', telemetryError);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withFallback(
  primary: ParserAdapter,
  fallback: ParserAdapter,
  telemetry: FallbackTelemetry = defaultTelemetry
): ParserAdapter {
  return {
    id: primary.id,
    async parse(content: string, options: ParseOptions) {
      try {
        return await primary.parse(content, options);
      } catch (primaryError) {
        safeFireTelemetry(telemetry, {
          error: describeError(primaryError),
          fallback: fallback.id,
          primary: primary.id,
        });
        // Double-failure (nit #991): if the fallback ALSO throws, fire a
        // distinct DOUBLE-FAILURE telemetry event so dashboards can
        // distinguish "primary fell back to babel" (normal) from "both
        // adapters died" (urgent).
        try {
          return await fallback.parse(content, options);
        } catch (fallbackError) {
          safeFireTelemetry(telemetry, {
            error: `DOUBLE-FAILURE: primary ${primary.id} threw "${describeError(primaryError)}"; fallback ${fallback.id} also threw "${describeError(fallbackError)}"`,
            fallback: fallback.id,
            primary: primary.id,
          });
          throw fallbackError;
        }
      }
    },
  };
}
