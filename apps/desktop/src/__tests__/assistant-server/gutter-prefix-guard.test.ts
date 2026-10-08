import { looksLikeReadWorkspaceFileGutterOutput } from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';

describe('looksLikeReadWorkspaceFileGutterOutput', () => {
  describe('negatives — must stay writable', () => {
    it('does not mistake markdown ordered-list markers for gutters', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput(
          '1. First step\n2. Second step\n3. Third step\n4. Fourth'
        )
      ).toBe(false);
    });

    it('does not mistake non-sequential timestamp or log prefixes for gutters', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput(
          '12: connection established\n45: retrying\n90: gave up'
        )
      ).toBe(false);
    });

    it('does not refuse one gutter-looking line among otherwise normal content', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput(
          'export const answer = 42;\n42: the answer\nexport default answer;\n'
        )
      ).toBe(false);
    });

    it('does not mistake non-sequential code or configuration entries for gutters', () => {
      expect(looksLikeReadWorkspaceFileGutterOutput('10: retries\n30: retries\n60: retries')).toBe(
        false
      );
    });

    it('does not refuse a two-line sequential snippet (below the 3-line floor)', () => {
      expect(looksLikeReadWorkspaceFileGutterOutput('1: a\n2: b')).toBe(false);
    });

    it('never refuses two sequential matching lines regardless of span', () => {
      expect(looksLikeReadWorkspaceFileGutterOutput('99: a\n100: b\n\n')).toBe(false);
    });

    it('knowingly allows a legitimate page-1-shaped YAML numeric-key mapping', () => {
      // Coverage boundary (PR #2352 review): textually identical to a page-1
      // gutter paste. A blocked legitimate write is worse than a missed
      // page-1 paste, which the model's own read-verify cycle still catches.
      expect(looksLikeReadWorkspaceFileGutterOutput('1: January\n2: February\n3: March')).toBe(
        false
      );
    });

    it('knowingly allows a 1-based sequential run of any length', () => {
      expect(looksLikeReadWorkspaceFileGutterOutput('1: a\n2: b\n3: c\n4: d\n5: e')).toBe(false);
    });

    it('rejects two unrelated reads concatenated together (span fails per-run)', () => {
      // The realistic shape of pasting two non-adjacent reads back to back:
      // the jump between them blows the tight-span bound even though every
      // individual step still moves forward.
      expect(looksLikeReadWorkspaceFileGutterOutput('40: a\n41: b\n100: c\n101: d')).toBe(false);
    });
  });

  describe('positives — must refuse', () => {
    it('refuses a pasted gutter block', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput(
          '10: import x\n11: \n12: const value = x;\n13: \n14: value();\n15: export default x;'
        )
      ).toBe(true);
    });

    it('refuses exactly three sequential matching lines', () => {
      expect(looksLikeReadWorkspaceFileGutterOutput('7: a\n8: b\n9: c\n')).toBe(true);
    });

    it('refuses a verbatim five-line gutter block starting past line 1', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput(
          '137: alpha\n138: beta\n139: gamma\n140: delta\n141: epsilon'
        )
      ).toBe(true);
    });

    it('still refuses a gutter block even with non-matching lines interspersed', () => {
      expect(
        looksLikeReadWorkspaceFileGutterOutput('20: a\n21: b\nnormal content\n22: c\n23: d')
      ).toBe(true);
    });

    it('refuses a gutter block with one line deleted (tight-span tolerance)', () => {
      // The model pasted a gutter block, then deleted line 12 while editing —
      // the realistic failure mode a strict +1-every-step rule would miss.
      expect(looksLikeReadWorkspaceFileGutterOutput('10: a\n11: b\n13: c\n14: d\n15: e')).toBe(
        true
      );
    });

    it('refuses a gutter block with a repeated boundary number', () => {
      // A line split across a page boundary re-emits the same line number as
      // the prefix on both halves; a verbatim paste of both pages repeats it.
      expect(looksLikeReadWorkspaceFileGutterOutput('40: a\n41: b\n42: c\n42: d\n43: e')).toBe(
        true
      );
    });

    it('still refuses a perfect gutter block with one absurd trailing line', () => {
      // An out-of-safe-integer line number must disqualify only that line,
      // not disable the guard for the rest of an otherwise perfect block.
      expect(
        looksLikeReadWorkspaceFileGutterOutput('10: a\n11: b\n12: c\n99999999999999999999: x')
      ).toBe(true);
    });
  });
});
