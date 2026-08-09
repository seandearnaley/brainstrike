import { describe, expect, it } from 'vitest';
import { looksLikeReadWorkspaceFileGutterOutput } from '../../assistant-server/gutter-prefix-guard';

describe('looksLikeReadWorkspaceFileGutterOutput', () => {
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

  it('does not refuse a two-line sequential snippet', () => {
    expect(looksLikeReadWorkspaceFileGutterOutput('1: a\n2: b')).toBe(false);
  });

  it('refuses a pasted gutter block', () => {
    expect(
      looksLikeReadWorkspaceFileGutterOutput(
        '10: import x\n11: \n12: const value = x;\n13: \n14: value();\n15: export default x;'
      )
    ).toBe(true);
  });

  it('refuses exactly three sequential matching lines when all non-empty lines match', () => {
    expect(looksLikeReadWorkspaceFileGutterOutput('7: a\n8: b\n9: c\n')).toBe(true);
  });

  it('refuses at the 80 percent majority boundary', () => {
    expect(
      looksLikeReadWorkspaceFileGutterOutput('20: a\n21: b\nnormal content\n22: c\n23: d')
    ).toBe(true);
  });

  it('never refuses two sequential matching lines regardless of percentage', () => {
    expect(looksLikeReadWorkspaceFileGutterOutput('99: a\n100: b\n\n')).toBe(false);
  });
});
