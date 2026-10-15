// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatPreviewFileSize } from '../utils/preview-formatters';

describe('formatPreviewFileSize', () => {
  it('renders the unavailable dash for undefined', () => {
    expect(formatPreviewFileSize(undefined)).toBe('—');
  });

  it('renders sub-kilobyte sizes in whole bytes — never "0.0 KB"', () => {
    // Regression: everything was forced through KB, so a 12-byte file
    // rendered "0.0 KB" in the Size column.
    expect(formatPreviewFileSize(0)).toBe('0 B');
    expect(formatPreviewFileSize(12)).toBe('12 B');
    expect(formatPreviewFileSize(1023)).toBe('1023 B');
  });

  it('renders kilobytes with one decimal', () => {
    expect(formatPreviewFileSize(1024)).toBe('1.0 KB');
    expect(formatPreviewFileSize(3072)).toBe('3.0 KB');
    expect(formatPreviewFileSize(1536)).toBe('1.5 KB');
  });

  it('scales to MB and GB instead of ballooning the KB figure', () => {
    expect(formatPreviewFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatPreviewFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
