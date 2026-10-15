// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CSVColumn,
  createCSVBlob,
  escapeCSVValue,
  formatDate,
  formatFileSize,
  generateCSV,
  generateCSVFilename,
  truncateContent,
} from '../csv-export-core';

describe('escapeCSVValue', () => {
  it('should return empty string for null', () => {
    expect(escapeCSVValue(null)).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(escapeCSVValue(undefined)).toBe('');
  });

  it('should return string as-is if no special characters', () => {
    expect(escapeCSVValue('simple text')).toBe('simple text');
    expect(escapeCSVValue('hello world')).toBe('hello world');
    expect(escapeCSVValue('123')).toBe('123');
  });

  it('should convert numbers to strings', () => {
    expect(escapeCSVValue(123)).toBe('123');
    expect(escapeCSVValue(45.67)).toBe('45.67');
    expect(escapeCSVValue(0)).toBe('0');
  });

  it('should wrap in quotes if contains comma', () => {
    expect(escapeCSVValue('hello, world')).toBe('"hello, world"');
    expect(escapeCSVValue('value1,value2')).toBe('"value1,value2"');
  });

  it('should wrap in quotes if contains newline', () => {
    expect(escapeCSVValue('hello\nworld')).toBe('"hello\nworld"');
    expect(escapeCSVValue('line1\nline2\nline3')).toBe('"line1\nline2\nline3"');
  });

  it('should wrap in quotes and escape quotes if contains quotes', () => {
    expect(escapeCSVValue('hello "world"')).toBe('"hello ""world"""');
    expect(escapeCSVValue('"quoted"')).toBe('"""quoted"""');
  });

  it('should handle multiple special characters', () => {
    expect(escapeCSVValue('hello, "world"\nnext line')).toBe('"hello, ""world""\nnext line"');
  });

  it('should handle empty string', () => {
    expect(escapeCSVValue('')).toBe('');
  });

  it('should handle strings with only special characters', () => {
    expect(escapeCSVValue(',')).toBe('","');
    expect(escapeCSVValue('"')).toBe('""""');
    expect(escapeCSVValue('\n')).toBe('"\n"');
  });
});

describe('createCSVBlob', () => {
  it('should create blob with BOM by default', () => {
    const content = 'header1,header2\nvalue1,value2';
    const blob = createCSVBlob(content);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(blob.size).toBeGreaterThan(content.length); // BOM adds bytes
  });

  it('should create blob without BOM when specified', () => {
    const content = 'header1,header2\nvalue1,value2';
    const blob = createCSVBlob(content, false);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(blob.size).toBe(content.length);
  });

  it('should handle empty content', () => {
    const blob = createCSVBlob('');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('should handle large content', () => {
    const largeContent = 'header1,header2\n'.repeat(10_000);
    const blob = createCSVBlob(largeContent);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(largeContent.length);
  });

  it('should preserve newlines and special characters', () => {
    const content = 'a,b\n"c","d"\n';
    const blob = createCSVBlob(content);
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe('generateCSVFilename', () => {
  beforeEach(() => {
    // Mock Date to ensure consistent timestamps
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-20T12:34:56.789Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should generate filename with default prefix and extension', () => {
    const filename = generateCSVFilename();
    expect(filename).toMatch(/^export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    expect(filename).toContain('export-2025-11-20T12-34-56.csv');
  });

  it('should use custom prefix', () => {
    const filename = generateCSVFilename('my-data');
    expect(filename).toContain('my-data-');
    expect(filename).toMatch(/^my-data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
  });

  it('should use custom extension', () => {
    const filename = generateCSVFilename('export', 'txt');
    expect(filename).toMatch(/^export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt$/);
    expect(filename).toContain('.txt');
  });

  it('should use both custom prefix and extension', () => {
    const filename = generateCSVFilename('report', 'tsv');
    expect(filename).toMatch(/^report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tsv$/);
    expect(filename).toContain('report-');
    expect(filename).toContain('.tsv');
  });

  it('should not contain colons or dots in timestamp', () => {
    const filename = generateCSVFilename();
    const timestampPart = filename.split('-').slice(1, -1).join('-');
    expect(timestampPart).not.toContain(':');
    expect(timestampPart).not.toContain('.');
  });
});

describe('formatFileSize', () => {
  it('should format bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('should format kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('formatDate', () => {
  it('should format valid ISO dates', () => {
    const date = '2025-11-20T12:00:00Z';
    const result = formatDate(date);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return empty string for undefined', () => {
    expect(formatDate(undefined)).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(formatDate('')).toBe('');
  });

  it('should return "Invalid Date" for invalid date strings', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date');
    expect(formatDate('invalid')).toBe('Invalid Date');
  });
});

describe('truncateContent', () => {
  it('should return empty string for undefined', () => {
    expect(truncateContent(undefined, 10)).toBe('');
  });

  it('should return content as-is if shorter than max length', () => {
    expect(truncateContent('short', 10)).toBe('short');
    expect(truncateContent('hello', 10)).toBe('hello');
  });

  it('should truncate and add ellipsis if longer than max length', () => {
    expect(truncateContent('this is a very long string', 10)).toBe('this is a ...');
    expect(truncateContent('hello world', 5)).toBe('hello...');
  });

  it('should handle exact length match', () => {
    expect(truncateContent('exact', 5)).toBe('exact');
  });

  it('should handle very small max length', () => {
    expect(truncateContent('hello', 1)).toBe('h...');
    expect(truncateContent('hello', 0)).toBe('...');
  });

  it('should handle empty strings', () => {
    expect(truncateContent('', 10)).toBe('');
  });

  it('should handle multi-line content', () => {
    const multiline = 'line1\nline2\nline3\nline4';
    const result = truncateContent(multiline, 10);
    expect(result).toBe('line1\nline...');
  });
});

describe('generateCSV', () => {
  interface TestRecord {
    active: boolean;
    email: string;
    id: number;
    name: string;
  }

  const columns: CSVColumn<TestRecord>[] = [
    { getValue: (record) => record.id, header: 'ID' },
    { getValue: (record) => record.name, header: 'Name' },
    { getValue: (record) => record.email, header: 'Email' },
    { getValue: (record) => (record.active ? 'Yes' : 'No'), header: 'Active' },
  ];

  it('should generate CSV with headers only for empty records', () => {
    const csv = generateCSV<TestRecord>([], columns);
    expect(csv).toBe('ID,Name,Email,Active');
  });

  it('should generate CSV with single record', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John Doe' },
    ];

    const csv = generateCSV(records, columns);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('ID,Name,Email,Active');
    expect(lines[1]).toBe('1,John Doe,john@example.com,Yes');
  });

  it('should generate CSV with multiple records', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John Doe' },
      { active: false, email: 'jane@example.com', id: 2, name: 'Jane Smith' },
      { active: true, email: 'bob@example.com', id: 3, name: 'Bob Johnson' },
    ];

    const csv = generateCSV(records, columns);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(4); // 1 header + 3 records
    expect(lines[0]).toBe('ID,Name,Email,Active');
    expect(lines[1]).toBe('1,John Doe,john@example.com,Yes');
    expect(lines[2]).toBe('2,Jane Smith,jane@example.com,No');
    expect(lines[3]).toBe('3,Bob Johnson,bob@example.com,Yes');
  });

  it('should escape values with commas', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'Doe, John' },
    ];

    const csv = generateCSV(records, columns);
    const lines = csv.split('\n');

    expect(lines[1]).toBe('1,"Doe, John",john@example.com,Yes');
  });

  it('should escape values with quotes', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John "The Boss" Doe' },
    ];

    const csv = generateCSV(records, columns);
    const lines = csv.split('\n');

    expect(lines[1]).toBe('1,"John ""The Boss"" Doe",john@example.com,Yes');
  });

  it('should escape values with newlines', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John\nDoe' },
    ];

    const csv = generateCSV(records, columns);

    // CSV contains: ID,Name,Email,Active\n1,"John\nDoe",john@example.com,Yes
    // The escaped name has a newline inside quotes, so we need to check the full CSV
    expect(csv).toContain('1,"John\nDoe",john@example.com,Yes');
    expect(csv.split('\n')[0]).toBe('ID,Name,Email,Active');
  });

  it('should handle null and undefined values', () => {
    interface NullableRecord {
      email: string | undefined;
      id: number;
      name: string | null;
    }

    const nullableColumns: CSVColumn<NullableRecord>[] = [
      { getValue: (record) => record.id, header: 'ID' },
      { getValue: (record) => record.name, header: 'Name' },
      { getValue: (record) => record.email, header: 'Email' },
    ];

    const records: NullableRecord[] = [
      { email: undefined, id: 1, name: null },
      { email: 'john@example.com', id: 2, name: 'John' },
    ];

    const csv = generateCSV(records, nullableColumns);
    const lines = csv.split('\n');

    expect(lines[1]).toBe('1,,');
    expect(lines[2]).toBe('2,John,john@example.com');
  });

  it('should handle empty columns array', () => {
    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John' },
    ];

    const csv = generateCSV(records, []);
    expect(csv).toBe('\n');
  });

  it('should handle headers with special characters', () => {
    const specialColumns: CSVColumn<TestRecord>[] = [
      { getValue: (record) => record.id, header: 'ID#' },
      { getValue: (record) => record.name, header: 'Name (Full)' },
      { getValue: (record) => record.email, header: 'Email, Address' },
    ];

    const records: TestRecord[] = [
      { active: true, email: 'john@example.com', id: 1, name: 'John' },
    ];

    const csv = generateCSV(records, specialColumns);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('ID#,Name (Full),"Email, Address"');
  });

  it('should handle complex getValue functions', () => {
    interface ComplexRecord {
      array: string[];
      data: {
        nested: {
          value: number;
        };
      };
    }

    const complexColumns: CSVColumn<ComplexRecord>[] = [
      { getValue: (record) => record.data.nested.value, header: 'Nested Value' },
      { getValue: (record) => record.array.length, header: 'Array Length' },
      {
        getValue: (record) => record.array[0] ?? 'N/A',
        header: 'First Item',
      },
    ];

    const records: ComplexRecord[] = [
      {
        array: ['first', 'second'],
        data: { nested: { value: 42 } },
      },
    ];

    const csv = generateCSV(records, complexColumns);
    const lines = csv.split('\n');

    expect(lines[1]).toBe('42,2,first');
  });

  it('should handle large datasets', () => {
    const largeRecords: TestRecord[] = Array.from({ length: 1000 }, (_, index) => ({
      active: index % 2 === 0,
      email: `user${index + 1}@example.com`,
      id: index + 1,
      name: `User ${index + 1}`,
    }));

    const csv = generateCSV(largeRecords, columns);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(1001); // 1 header + 1000 records
    expect(lines[0]).toBe('ID,Name,Email,Active');
    expect(lines[1]).toBe('1,User 1,user1@example.com,Yes'); // index 0, even -> active=true
    expect(lines[1000]).toBe('1000,User 1000,user1000@example.com,No'); // index 999, odd -> active=false
  });
});
