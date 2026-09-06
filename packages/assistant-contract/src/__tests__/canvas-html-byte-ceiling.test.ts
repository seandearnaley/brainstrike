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
  return ManageCanvasInputSchema.safeParse({ action: 'create', html, title: 'probe' });
}

describe('canvas HTML byte ceiling', () => {
  it('rejects an astral payload that is under the code-point limit but over the byte limit', () => {
    // 3M code points — comfortably under .max(8_000_000) — but 12 MB of UTF-8.
    const html = EMOJI.repeat(3_000_000);
    expect(html.length).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(MAX_BYTES);
    expect(create(html).success).toBe(false);
  });

  it('still accepts an ASCII payload just under the ceiling', () => {
    const html = 'a'.repeat(MAX_BYTES - 1);
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(create(html).success).toBe(true);
  });

  it('pins the Zod behaviour this guard exists for', () => {
    // If a future Zod goes back to counting bytes, or to UTF-16 units, the
    // premise above changes and this says so rather than the comment rotting.
    // 10 emoji = 10 code points, 20 UTF-16 units, 40 bytes.
    expect(z.string().max(10).safeParse(EMOJI.repeat(10)).success).toBe(true);
    expect(z.string().max(19).safeParse(EMOJI.repeat(20)).success).toBe(false);
  });
});
