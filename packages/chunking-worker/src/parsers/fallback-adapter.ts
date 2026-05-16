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
      } catch (error) {
        telemetry({
          error: error instanceof Error ? error.message : String(error),
          fallback: fallback.id,
          primary: primary.id,
        });
        return fallback.parse(content, options);
      }
    },
  };
}
