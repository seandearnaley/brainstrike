// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatDate, formatFileSize } from '../format';

describe('formatFileSize', () => {
  it('should format bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('should format kilobytes correctly', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10_240)).toBe('10.0 KB');
  });

  it('should format megabytes correctly', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('should round to one decimal place', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1587)).toBe('1.5 KB'); // 1.549... rounds to 1.5
    expect(formatFileSize(1638)).toBe('1.6 KB'); // 1.599... rounds to 1.6
  });

  it('should handle large files', () => {
    expect(formatFileSize(100 * 1024 * 1024)).toBe('100.0 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1024.0 MB');
  });

  it('should handle edge cases', () => {
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1025)).toBe('1.0 KB');
  });
});

describe('formatDate', () => {
  it('should format valid ISO date strings', () => {
    const isoDate = '2025-01-15T10:30:00.000Z';
    const result = formatDate(isoDate);
    // Result will vary by locale, just check it's not empty and not the original string
    expect(result).toBeTruthy();
    expect(result).not.toBe(isoDate);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle date with different formats', () => {
    const dates = ['2025-01-15T10:30:00Z', '2025-01-15T10:30:00.123Z', '2025-01-15'];

    for (const date of dates) {
      const result = formatDate(date);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('should return "Invalid Date" for invalid date strings', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date');
    expect(formatDate('invalid')).toBe('Invalid Date');
    expect(formatDate('2025-13-45')).toBe('Invalid Date'); // Invalid month/day
  });

  it('should return "Invalid Date" for empty strings', () => {
    expect(formatDate('')).toBe('Invalid Date');
  });

  it('should handle various ISO formats', () => {
    // With milliseconds
    const withMs = '2025-11-20T12:00:00.500Z';
    expect(formatDate(withMs)).toBeTruthy();

    // Without Z
    const withoutZ = '2025-11-20T12:00:00';
    expect(formatDate(withoutZ)).toBeTruthy();

    // Date only
    const dateOnly = '2025-11-20';
    expect(formatDate(dateOnly)).toBeTruthy();
  });

  it('should handle timezone information', () => {
    const withTimezone = '2025-11-20T12:00:00+05:30';
    const result = formatDate(withTimezone);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle year boundaries', () => {
    expect(formatDate('2024-12-31T23:59:59Z')).toBeTruthy();
    expect(formatDate('2025-01-01T00:00:00Z')).toBeTruthy();
  });

  it('should handle leap year dates', () => {
    expect(formatDate('2024-02-29T12:00:00Z')).toBeTruthy(); // Valid leap year date
  });
});
