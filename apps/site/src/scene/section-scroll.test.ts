import { describe, expect, it } from 'vitest';
import { computeSectionScrollTop } from './section-scroll';

describe('computeSectionScrollTop', () => {
  it('lands on the stable section boundary', () => {
    expect(
      computeSectionScrollTop({
        maximumScrollTop: 8000,
        sectionDocumentTop: 1098,
      })
    ).toBe(1098);
  });

  it('clamps navigation at the document boundaries', () => {
    expect(
      computeSectionScrollTop({
        maximumScrollTop: 900,
        sectionDocumentTop: 0,
      })
    ).toBe(0);

    expect(
      computeSectionScrollTop({
        maximumScrollTop: 900,
        sectionDocumentTop: 1900,
      })
    ).toBe(900);
  });

  it('returns the same destination when content measurements change', () => {
    const metrics = {
      maximumScrollTop: 8000,
      sectionDocumentTop: 5490,
    } as const;

    expect(computeSectionScrollTop(metrics)).toBe(5490);
    expect(computeSectionScrollTop(metrics)).toBe(5490);
  });

  it('rejects malformed section coordinates', () => {
    expect(() =>
      computeSectionScrollTop({
        maximumScrollTop: 900,
        sectionDocumentTop: Number.NaN,
      })
    ).toThrow('Section document top must be a finite, non-negative number.');
  });
});
