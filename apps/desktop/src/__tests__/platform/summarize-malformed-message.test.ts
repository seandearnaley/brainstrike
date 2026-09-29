import { describe, expect, it } from 'vitest';
import { truncateForLog } from '../../platform/summarize-malformed-message';

describe('truncateForLog', () => {
  it('keeps a string of at most 64 code points unchanged', () => {
    expect(truncateForLog('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('keeps 64 astral characters unchanged: their UTF-16 length is 128, but they are 64 code points', () => {
    expect(truncateForLog('😀'.repeat(64))).toBe('😀'.repeat(64));
  });

  it('cuts at 64 code points, never splitting a surrogate pair into a lone half', () => {
    const cut = truncateForLog('😀'.repeat(70));

    expect(cut).toBe(`${'😀'.repeat(64)}…`);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(cut)
    ).toBe(false);
  });
});
