import { describe, expect, it } from 'vitest';
import { formatDate, formatFileSize } from '../utils/format';

describe('formatFileSize', () => {
  it('formats bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10_240)).toBe('10.0 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('handles boundary at exactly 1024 bytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
  });

  it('handles boundary at exactly 1 MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('handles very large files', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1024.0 MB');
  });

  it('handles single byte', () => {
    expect(formatFileSize(1)).toBe('1 B');
  });
});

describe('formatDate', () => {
  it('formats a valid ISO date string', () => {
    const result = formatDate('2025-01-15T10:30:00.000Z');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns "Invalid Date" for garbage input', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date');
  });

  it('returns "Invalid Date" for empty string', () => {
    expect(formatDate('')).toBe('Invalid Date');
  });

  it('handles date-only ISO strings', () => {
    const result = formatDate('2025-06-15');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles timezone offset format', () => {
    const result = formatDate('2025-01-15T10:30:00+05:30');
    expect(result).toBeTruthy();
  });
});
