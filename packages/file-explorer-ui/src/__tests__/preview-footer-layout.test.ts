import { describe, expect, it } from 'vitest';
import {
  clampPreviewFooterHeight,
  getPreviewFooterModeHeight,
  inferPreviewFooterMode,
  PREVIEW_FOOTER_HEIGHTS,
} from '../preview/preview-footer-layout';

describe('preview-footer-layout', () => {
  it('clamps and rounds footer heights', () => {
    expect(clampPreviewFooterHeight(PREVIEW_FOOTER_HEIGHTS.min - 20)).toBe(
      PREVIEW_FOOTER_HEIGHTS.min
    );
    expect(clampPreviewFooterHeight(PREVIEW_FOOTER_HEIGHTS.max + 20)).toBe(
      PREVIEW_FOOTER_HEIGHTS.max
    );
    expect(clampPreviewFooterHeight(227.6)).toBe(228);
  });

  it('returns canonical heights for each mode', () => {
    expect(getPreviewFooterModeHeight('compact')).toBe(PREVIEW_FOOTER_HEIGHTS.compact);
    expect(getPreviewFooterModeHeight('default')).toBe(PREVIEW_FOOTER_HEIGHTS.default);
    expect(getPreviewFooterModeHeight('expanded')).toBe(PREVIEW_FOOTER_HEIGHTS.expanded);
  });

  it('infers compact mode at or below compact threshold', () => {
    const compactThreshold = (PREVIEW_FOOTER_HEIGHTS.compact + PREVIEW_FOOTER_HEIGHTS.default) / 2;

    expect(inferPreviewFooterMode(compactThreshold - 1)).toBe('compact');
    expect(inferPreviewFooterMode(compactThreshold)).toBe('compact');
    expect(inferPreviewFooterMode(PREVIEW_FOOTER_HEIGHTS.min)).toBe('compact');
  });

  it('infers default mode between compact and expanded thresholds', () => {
    const compactThreshold = (PREVIEW_FOOTER_HEIGHTS.compact + PREVIEW_FOOTER_HEIGHTS.default) / 2;
    const expandedThreshold =
      (PREVIEW_FOOTER_HEIGHTS.default + PREVIEW_FOOTER_HEIGHTS.expanded) / 2;

    expect(inferPreviewFooterMode(compactThreshold + 1)).toBe('default');
    expect(inferPreviewFooterMode(expandedThreshold - 1)).toBe('default');
  });

  it('infers expanded mode at or above expanded threshold', () => {
    const expandedThreshold =
      (PREVIEW_FOOTER_HEIGHTS.default + PREVIEW_FOOTER_HEIGHTS.expanded) / 2;

    expect(inferPreviewFooterMode(expandedThreshold)).toBe('expanded');
    expect(inferPreviewFooterMode(expandedThreshold + 1)).toBe('expanded');
    expect(inferPreviewFooterMode(PREVIEW_FOOTER_HEIGHTS.max)).toBe('expanded');
  });
});
