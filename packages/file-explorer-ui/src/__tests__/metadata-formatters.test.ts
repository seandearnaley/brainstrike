// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatFileSize, formatTokenCount } from '../utils/metadata-formatters';

describe('formatFileSize', () => {
  it('renders the unavailable dash for undefined', () => {
    expect(formatFileSize(undefined)).toBe('—');
  });

  it('renders sub-kilobyte sizes in whole bytes — never "0.0 KB"', () => {
    // Regression: everything was forced through KB, so a 12-byte file
    // rendered "0.0 KB" in the Size column.
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(12)).toBe('12 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('renders kilobytes with one decimal', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(3072)).toBe('3.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('scales to MB and GB instead of ballooning the KB figure', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});

describe('formatTokenCount', () => {
  it('keeps counts under a thousand whole and compacts larger ones to one decimal', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1234)).toBe('1.2K');
    expect(formatTokenCount(3_400_000)).toBe('3.4M');
  });
});
