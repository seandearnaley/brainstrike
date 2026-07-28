import { describe, expect, it } from 'vitest';
import {
  CHUNK_OVERLAP_BOUNDS,
  CHUNK_SIZE_BOUNDS,
  CHUNK_TOKEN_LIMIT_BOUNDS,
  getChunkingPreset,
  validateChunkingSettings,
  validateChunkOverlap,
  validateChunkSize,
  validateChunkTokenLimit,
} from '../index';

/**
 * BST-423. These invariants used to live nowhere: the import-settings store
 * silently CLAMPED (`Math.max(0, Math.floor(n))`) and the settings UI relied on
 * HTML `min`/`max` attributes, which a browser does not enforce against typing
 * or paste. The two also disagreed — the store turned a non-finite token limit
 * into 512 via `Math.floor(n) || 512` (so a legitimate 0 became 512 too) while
 * the UI used a separate `Number.isFinite(...) ? clamp : 512` expression.
 *
 * The rule this file pins: an impossible value is REJECTED and named, never
 * quietly reshaped into a nearby possible one.
 */
describe('chunking settings field validation', () => {
  it('accepts in-range integers and returns them unchanged', () => {
    expect(validateChunkSize(256)).toEqual({ ok: true, value: 256 });
    expect(validateChunkOverlap(0)).toEqual({ ok: true, value: 0 });
    expect(validateChunkTokenLimit(4096)).toEqual({ ok: true, value: 4096 });
  });

  it('accepts the exact bounds (inclusive)', () => {
    expect(validateChunkSize(CHUNK_SIZE_BOUNDS.min).ok).toBe(true);
    expect(validateChunkSize(CHUNK_SIZE_BOUNDS.max).ok).toBe(true);
    expect(validateChunkOverlap(CHUNK_OVERLAP_BOUNDS.min).ok).toBe(true);
    expect(validateChunkTokenLimit(CHUNK_TOKEN_LIMIT_BOUNDS.max).ok).toBe(true);
  });

  it('rejects NaN rather than substituting a default', () => {
    // `Number('')` is 0 and `Number('abc')` is NaN — both reachable from the
    // settings inputs, and both used to be silently absorbed.
    const result = validateChunkSize(Number.NaN);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.issue.code).toBe('not-a-number');
    expect(result.issue.field).toBe('chunkSize');
  });

  it('rejects Infinity', () => {
    expect(validateChunkSize(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateChunkOverlap(Number.NEGATIVE_INFINITY).ok).toBe(false);
  });

  it('rejects non-integers rather than flooring them', () => {
    const result = validateChunkSize(256.7);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.issue.code).toBe('not-an-integer');
  });

  it('rejects out-of-range values rather than clamping them', () => {
    const tooSmall = validateChunkSize(CHUNK_SIZE_BOUNDS.min - 1);
    expect(tooSmall.ok).toBe(false);
    if (tooSmall.ok) {
      throw new Error('unreachable');
    }
    expect(tooSmall.issue.code).toBe('below-minimum');

    const tooLarge = validateChunkTokenLimit(CHUNK_TOKEN_LIMIT_BOUNDS.max + 1);
    expect(tooLarge.ok).toBe(false);
    if (tooLarge.ok) {
      throw new Error('unreachable');
    }
    expect(tooLarge.issue.code).toBe('above-maximum');
  });

  it('names the offending field and the bound in the message', () => {
    const result = validateChunkOverlap(-1);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    // The message is user-facing (rendered inline under the input), so it must
    // say what is wrong AND what would be acceptable.
    expect(result.issue.message).toContain('Overlap');
    expect(result.issue.message).toContain(String(CHUNK_OVERLAP_BOUNDS.min));
  });
});

describe('chunking settings cross-field validation', () => {
  it('accepts a coherent settings object', () => {
    const result = validateChunkingSettings({
      chunkOverlap: 50,
      chunkSize: 256,
      chunkTokenLimit: 4096,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects overlap greater than or equal to size', () => {
    // Overlap >= size means every chunk re-reads at least the whole previous
    // chunk: the splitter either stalls or emits unbounded duplicate text.
    // Each field is individually in range here, so ONLY a cross-field check
    // catches it — which is exactly what was missing.
    const equal = validateChunkingSettings({
      chunkOverlap: 256,
      chunkSize: 256,
      chunkTokenLimit: 4096,
    });
    expect(equal.ok).toBe(false);
    if (equal.ok) {
      throw new Error('unreachable');
    }
    expect(equal.issues.map((issue) => issue.code)).toContain('overlap-not-less-than-size');

    const greater = validateChunkingSettings({
      chunkOverlap: 200,
      chunkSize: 128,
      chunkTokenLimit: 4096,
    });
    expect(greater.ok).toBe(false);
  });

  it('reports every failing field at once, not just the first', () => {
    const result = validateChunkingSettings({
      chunkOverlap: Number.NaN,
      chunkSize: 1,
      chunkTokenLimit: 999_999,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.issues.map((issue) => issue.field).sort()).toEqual([
      'chunkOverlap',
      'chunkSize',
      'chunkTokenLimit',
    ]);
  });

  it('does not report a cross-field issue when a field is already invalid', () => {
    // Comparing against NaN would produce a nonsense second error and bury the
    // real one. The cross-field rule only runs on fields that parsed.
    const result = validateChunkingSettings({
      chunkOverlap: Number.NaN,
      chunkSize: 256,
      chunkTokenLimit: 4096,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.issues.map((issue) => issue.code)).not.toContain('overlap-not-less-than-size');
  });
});

describe('every shipped preset satisfies its own invariants', () => {
  // If a preset ever violated the rules the UI enforces, selecting it would put
  // the store into a state the user cannot re-enter by hand. This is also the
  // anti-vacuity check on the bounds themselves: bounds narrower than the
  // shipped data would fail here rather than silently rejecting real presets.
  const presetIds = [
    'balanced',
    'codebase',
    'strict-code',
    'docs',
    'api-reference',
    'structured-data',
    'large-context',
  ] as const;

  it.each(presetIds)('%s', (id) => {
    const preset = getChunkingPreset(id);
    const result = validateChunkingSettings({
      chunkOverlap: preset.chunkOverlap,
      chunkSize: preset.chunkSize,
      chunkTokenLimit: preset.tokenLimit,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        chunkOverlap: preset.chunkOverlap,
        chunkSize: preset.chunkSize,
        chunkTokenLimit: preset.tokenLimit,
      },
    });
  });
});
