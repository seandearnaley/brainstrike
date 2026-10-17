import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ManageCanvasInputSchema } from '../native-tools/schemas/schemas-workspace';

/**
 * The canvas HTML ceiling is stated in BYTES and has to be enforced in bytes.
 *
 * `manage-canvas-tool.ts` carries no size enforcement of its own, so unlike the
 * workspace-file content fields — which sit above an authoritative ~2 MB byte
 * cap in the desktop tool — this schema is the only thing standing between a
 * model and the text column. `.max()` counts CODE POINTS under Zod 4.5 (UTF-16
 * code units before that), so `.max(8_000_000)` alone admits eight million
 * astral characters: 31 MB of UTF-8, four times the documented limit, and twice
 * what the same line admitted under Zod 4.4.
 *
 * The unit is the whole point of these cases, which is why they use astral
 * input rather than ASCII — an ASCII-only test passes identically with or
 * without the fix and would prove nothing.
 */
const MAX_BYTES = 8_000_000;
const EMOJI = '\u{1F600}'; // 1 code point, 2 UTF-16 units, 4 UTF-8 bytes

function create(html: string) {
  return {
    success:
      Schema.decodeResult(ManageCanvasInputSchema, { onExcessProperty: 'error' })({
        action: 'create',
        html,
        title: 'probe',
      })._tag === 'Success',
  };
}

describe('canvas HTML byte ceiling', () => {
  it('rejects an astral payload that is under the code-point limit but over the byte limit', () => {
    // 3M emoji: 3M code points and 6M UTF-16 units — both comfortably under
    // .max(8_000_000) — but 12 MB of UTF-8. `.length` is UTF-16 units, which is
    // the larger of the two counts Zod might use, so asserting on it bounds
    // both.
    const html = EMOJI.repeat(3_000_000);
    expect(html.length).toBeLessThan(MAX_BYTES);
    expect(new TextEncoder().encode(html).length).toBeGreaterThan(MAX_BYTES);
    expect(create(html).success).toBe(false);
  });

  it('still accepts an ASCII payload just under the ceiling', () => {
    const html = 'a'.repeat(MAX_BYTES - 1);
    expect(new TextEncoder().encode(html).length).toBeLessThanOrEqual(MAX_BYTES);
    expect(create(html).success).toBe(true);
  });

  it('pins the Zod behaviour this guard exists for', () => {
    // These have to DISCRIMINATE between the three candidate units, or they
    // cannot detect the drift they exist to catch. 11 emoji is 11 code points,
    // 22 UTF-16 units and 44 bytes, so `max(21)` accepts it only if Zod counts
    // code points — it would reject under UTF-16 units (what 4.4 did) and under
    // bytes. A case like `max(19)` against 20 emoji looks similar and proves
    // nothing: 20 / 40 / 80 all exceed 19, so it fails whichever unit is in use.
    expect(z.string().max(21).safeParse(EMOJI.repeat(11)).success).toBe(true);
    // And the other direction: 11 code points is over `max(10)` under every
    // unit, which pins that `.max()` is still counting SOMETHING string-shaped
    // rather than having become a no-op.
    expect(z.string().max(10).safeParse(EMOJI.repeat(11)).success).toBe(false);
    expect(z.string().max(10).safeParse(EMOJI.repeat(10)).success).toBe(true);
  });
});
