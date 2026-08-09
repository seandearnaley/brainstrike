import { describe, expect, it } from 'vitest';
import { buildEmbedJobDedupeKey } from '../index';

describe('buildEmbedJobDedupeKey', () => {
  it('builds the canonical chunk/set/content-hash format', () => {
    expect(buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-1')).toBe('chunk-1:set-1:hash-1');
  });

  it('substitutes a placeholder for a null embedding set', () => {
    expect(buildEmbedJobDedupeKey('chunk-1', null, 'hash-1')).toBe('chunk-1:none:hash-1');
    expect(buildEmbedJobDedupeKey('chunk-1', undefined, 'hash-1')).toBe('chunk-1:none:hash-1');
  });

  it('is idempotent for identical inputs', () => {
    expect(buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-1')).toBe(
      buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-1')
    );
  });

  it('varies by chunk, by set, and by content hash', () => {
    const base = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-1');

    expect(buildEmbedJobDedupeKey('chunk-2', 'set-1', 'hash-1')).not.toBe(base);
    expect(buildEmbedJobDedupeKey('chunk-1', 'set-2', 'hash-1')).not.toBe(base);
    expect(buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-2')).not.toBe(base);
  });

  // Pins the single-format rule. A leading type segment (the retired
  // `embed:<chunkId>:<setId>:<modelKey>` shape) shifts every positional index by
  // one, which is what made BST-1214's `split_part(dedupe_key, ':', 1)` read
  // every failed embedding as merely pending.
  it('emits exactly three segments and no leading type tag', () => {
    const key = buildEmbedJobDedupeKey('chunk-1', 'set-1', 'hash-1');

    expect(key.split(':')).toHaveLength(3);
    expect(key.startsWith('embed:')).toBe(false);
  });

  it('rejects blank components rather than emitting an ambiguous key', () => {
    expect(() => buildEmbedJobDedupeKey('  ', 'set-1', 'hash-1')).toThrow(
      /chunk id/ // no silent fallback: a blank segment would collide across chunks
    );
    expect(() => buildEmbedJobDedupeKey('chunk-1', 'set-1', '  ')).toThrow(/content hash/);
  });

  // null/undefined is the legitimate "no set" signal. A blank string is a
  // caller bug of the same kind the two guards above refuse — coercing it to
  // the placeholder would collide every blank-set job with every genuinely
  // set-less one for that chunk.
  it('rejects a blank embedding set id instead of coercing it to the placeholder', () => {
    expect(() => buildEmbedJobDedupeKey('chunk-1', '  ', 'hash-1')).toThrow(/embedding set id/);
    expect(() => buildEmbedJobDedupeKey('chunk-1', '', 'hash-1')).toThrow(/embedding set id/);
  });
});
