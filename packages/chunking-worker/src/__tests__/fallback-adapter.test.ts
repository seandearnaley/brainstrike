/**
 * Tests for the per-file fallback wrapper (Phase 5 Cycle 5.2).
 *
 * Verifies that the safety net the PRD §7 aggressive rollout depends on
 * actually works: when the primary adapter throws, the wrapper silently
 * delegates to the fallback for that one parse, fires a telemetry event,
 * and never propagates the original error.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 5)
 */

import { describe, expect, it, vi } from 'vitest';
import { withFallback } from '../parsers/fallback-adapter';
import type { ParserAdapter } from '../parsers/types';

const ok: Awaited<ReturnType<ParserAdapter['parse']>> = { type: 'Program', start: 0, end: 11 };
const baseOptions = { errorRecovery: true, jsx: false, language: 'javascript' as const };

function makeAdapter(id: ParserAdapter['id'], impl: ParserAdapter['parse']): ParserAdapter {
  return { id, parse: impl };
}

describe('withFallback', () => {
  it('returns the primary result when the primary succeeds', async () => {
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => ok)
    );
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => ({ type: 'File' }))
    );
    const wrapped = withFallback(primary, fallback);

    const result = await wrapped.parse('const x = 1', baseOptions);

    expect(result).toEqual(ok);
    expect(fallback.parse).not.toHaveBeenCalled();
  });

  it('falls back to the fallback adapter when primary throws', async () => {
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    const fallbackResult = { type: 'File', start: 0, end: 11 };
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => fallbackResult)
    );
    const wrapped = withFallback(primary, fallback);

    const result = await wrapped.parse('const x = 1', baseOptions);

    expect(result).toEqual(fallbackResult);
    expect(fallback.parse).toHaveBeenCalledWith('const x = 1', baseOptions);
  });

  it('fires the telemetry hook with the failure details', async () => {
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => {
        throw new Error('upstream parser exploded');
      })
    );
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => ok)
    );
    const telemetry = vi.fn();
    const wrapped = withFallback(primary, fallback, telemetry);

    await wrapped.parse('x', baseOptions);

    expect(telemetry).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith({
      error: 'upstream parser exploded',
      fallback: 'babel',
      primary: 'oxc-native',
    });
  });

  it('does not propagate the primary error even if fallback also throws', async () => {
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => {
        throw new Error('primary failed');
      })
    );
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => {
        throw new Error('fallback also failed');
      })
    );
    const telemetry = vi.fn();
    const wrapped = withFallback(primary, fallback, telemetry);

    // We accept that the fallback's error propagates — there's no third
    // safety net. But the message should be the fallback's, not the
    // primary's, so debugging starts from the right place.
    await expect(wrapped.parse('x', baseOptions)).rejects.toThrow(/fallback also failed/);

    // Nit #991: double-failure case must fire a distinct telemetry event
    // so dashboards can distinguish "primary fell back to babel (normal)"
    // from "primary AND babel both died (urgent)".
    expect(telemetry).toHaveBeenCalledTimes(2);
    const doubleFailureCall = telemetry.mock.calls.find((call) =>
      String((call[0] as { error?: unknown }).error ?? '').startsWith('DOUBLE-FAILURE')
    );
    expect(doubleFailureCall).toBeDefined();
  });

  it('reports the primary id (not babel) so downstream telemetry attributes correctly', async () => {
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => ok)
    );
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => ({ type: 'File' }))
    );
    const wrapped = withFallback(primary, fallback);

    expect(wrapped.id).toBe('oxc-native');
  });

  it('still runs the fallback when the telemetry hook throws (P1 #991)', async () => {
    // Regression test for the chatgpt-codex P1 on #991: if a bad
    // telemetry sink throws, the fallback MUST still run. Without the
    // guard the throw would propagate, the fallback would never be
    // called, and a downstream-sink bug would turn into a chunking
    // pipeline failure.
    const primary = makeAdapter(
      'oxc-native',
      vi.fn(async () => {
        throw new Error('primary failed');
      })
    );
    const fallbackResult = { end: 11, start: 0, type: 'File' };
    const fallback = makeAdapter(
      'babel',
      vi.fn(async () => fallbackResult)
    );
    const buggyTelemetry = vi.fn(() => {
      throw new Error('telemetry sink misconfigured');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const wrapped = withFallback(primary, fallback, buggyTelemetry);
    const result = await wrapped.parse('x', baseOptions);

    expect(result).toEqual(fallbackResult);
    expect(buggyTelemetry).toHaveBeenCalledTimes(1);
    expect(fallback.parse).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
