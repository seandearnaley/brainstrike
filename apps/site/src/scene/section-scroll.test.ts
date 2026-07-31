import { describe, expect, it } from 'vitest';
import { computeSectionScrollTop } from './section-scroll';

describe('computeSectionScrollTop', () => {
  it('centers content that fits inside the usable viewport', () => {
    expect(
      computeSectionScrollTop({
        contentDocumentTop: 1098,
        contentHeight: 647,
        headerHeight: 76,
        maximumScrollTop: 8000,
        viewportGap: 24,
        viewportHeight: 900,
      })
    ).toBeCloseTo(933.5);
  });

  it('top-aligns content that is taller than the usable viewport', () => {
    expect(
      computeSectionScrollTop({
        contentDocumentTop: 5490,
        contentHeight: 830,
        headerHeight: 68,
        maximumScrollTop: 8000,
        viewportGap: 16,
        viewportHeight: 844,
      })
    ).toBe(5406);
  });

  it('clamps navigation at the start and end of the document', () => {
    expect(
      computeSectionScrollTop({
        contentDocumentTop: 40,
        contentHeight: 200,
        headerHeight: 76,
        maximumScrollTop: 900,
        viewportGap: 24,
        viewportHeight: 900,
      })
    ).toBe(0);

    expect(
      computeSectionScrollTop({
        contentDocumentTop: 1900,
        contentHeight: 400,
        headerHeight: 76,
        maximumScrollTop: 900,
        viewportGap: 24,
        viewportHeight: 900,
      })
    ).toBe(900);
  });

  it('rejects a viewport without usable reading space', () => {
    expect(() =>
      computeSectionScrollTop({
        contentDocumentTop: 500,
        contentHeight: 200,
        headerHeight: 760,
        maximumScrollTop: 900,
        viewportGap: 24,
        viewportHeight: 800,
      })
    ).toThrow('Section navigation requires positive usable viewport height.');
  });
});
