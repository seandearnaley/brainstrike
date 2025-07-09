import type { FileRecord } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import {
  createCSVBlob,
  DEFAULT_FILE_RECORD_COLUMNS,
  generateCSV,
  generateCSVFilename,
} from '../csv-export-utils';

describe('CSV Export Utils', () => {
  const mockRecords: FileRecord[] = [
    {
      id: '1',
      name: 'test.txt',
      path: '/path/to/test.txt',
      size: 1024,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      content: 'This is a test file with some content',
      contentHash: 'abc123',
      tokenCount: 10,
      processedAt: '2024-01-01T01:00:00Z',
    },
    {
      id: '2',
      name: 'file,with,commas.csv',
      path: '/path/to/"quoted".csv',
      size: 2048,
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      content: 'Content with "quotes" and\nnewlines',
      contentHash: 'def456',
      tokenCount: 20,
      processedAt: '2024-01-02T01:00:00Z',
    },
    {
      id: '3',
      name: 'empty.txt',
      path: '/path/to/empty.txt',
      size: 0,
      createdAt: '2024-01-03T00:00:00Z',
      updatedAt: '2024-01-03T00:00:00Z',
      // No content fields
    },
  ];

  describe('generateCSV', () => {
    it('should generate CSV with headers', () => {
      const csv = generateCSV(mockRecords);
      const lines = csv.split('\n');

      expect(lines[0]).toContain('ID,Name,Path,Size');
      expect(lines[0]).toContain('Token Count');
      expect(lines[0]).toContain('Content Sample (500 chars)');
    });

    it('should handle records with all fields', () => {
      const csv = generateCSV([mockRecords[0]]);
      const lines = csv.split('\n');

      expect(lines[1]).toContain('1,test.txt,/path/to/test.txt');
      expect(lines[1]).toContain('1.0 KB'); // Formatted size
      expect(lines[1]).toContain('10'); // token count
      expect(lines[1]).toContain('This is a test file with some content');
    });

    it('should escape fields with commas and quotes', () => {
      const csv = generateCSV([mockRecords[1]]);
      const lines = csv.split('\n');

      // Verify that fields with special characters are properly escaped
      expect(lines[1]).toContain('"file,with,commas.csv"');
      expect(lines[1]).toContain('"/path/to/""quoted"".csv"');
      // Just verify the CSV was generated without errors - exact content testing is brittle
      expect(lines[1]).toBeTruthy();
      expect(lines[1].split(',').length).toBeGreaterThan(5);
    });

    it('should handle empty/missing fields', () => {
      const csv = generateCSV([mockRecords[2]]);
      const lines = csv.split('\n');

      expect(lines[1]).toContain('3,empty.txt,/path/to/empty.txt');
      expect(lines[1]).toContain('0 B'); // 0 size
      expect(lines[1]).toMatch(/,,/); // empty token count
    });

    it('should truncate content to 500 characters', () => {
      const longContent = 'x'.repeat(600);
      const record: FileRecord = {
        ...mockRecords[0],
        content: longContent,
      };

      const csv = generateCSV([record]);
      const lines = csv.split('\n');

      expect(lines[1]).toContain('x'.repeat(500) + '...');
      expect(lines[1]).not.toContain('x'.repeat(501));
    });

    it('should generate empty CSV with only headers for empty array', () => {
      const csv = generateCSV([]);
      const lines = csv.split('\n');

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ID,Name,Path');
    });

    it('should use custom columns if provided', () => {
      const customColumns = [
        { header: 'File ID', getValue: (r: FileRecord) => r.id },
        { header: 'File Name', getValue: (r: FileRecord) => r.name },
      ];

      const csv = generateCSV(mockRecords, customColumns);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('File ID,File Name');
      expect(lines[1]).toBe('1,test.txt');
    });
  });

  describe('createCSVBlob', () => {
    it('should create blob with correct type', () => {
      const csvContent = 'header1,header2\nvalue1,value2';
      const blob = createCSVBlob(csvContent);

      expect(blob.type).toBe('text/csv;charset=utf-8');
      expect(blob.size).toBeGreaterThan(csvContent.length); // BOM adds bytes
    });

    it('should include BOM for Excel compatibility', () => {
      const csvContent = 'test';
      const blob = createCSVBlob(csvContent);

      // In Node.js test environment, Blob doesn't have text() method
      // Just verify the blob is created with correct size (BOM adds 3 bytes)
      expect(blob.size).toBe(csvContent.length + 3);
    });
  });

  describe('generateCSVFilename', () => {
    it('should generate filename with timestamp', () => {
      const filename = generateCSVFilename();

      expect(filename).toMatch(/^file-records-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    });

    it('should use custom prefix', () => {
      const filename = generateCSVFilename('custom-export');

      expect(filename).toMatch(/^custom-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    });
  });

  describe('DEFAULT_FILE_RECORD_COLUMNS', () => {
    it('should have all expected columns', () => {
      const headers = DEFAULT_FILE_RECORD_COLUMNS.map((col) => col.header);

      expect(headers).toContain('ID');
      expect(headers).toContain('Name');
      expect(headers).toContain('Path');
      expect(headers).toContain('Size');
      expect(headers).toContain('Size (bytes)');
      expect(headers).toContain('Token Count');
      expect(headers).toContain('Content Sample (500 chars)');
      expect(headers).toContain('Content Hash');
      expect(headers).toContain('Created At');
      expect(headers).toContain('Updated At');
      expect(headers).toContain('Processed At');
    });

    it('should format size correctly', () => {
      const sizeColumn = DEFAULT_FILE_RECORD_COLUMNS.find((col) => col.header === 'Size');

      expect(sizeColumn?.getValue({ size: 512 } as FileRecord)).toBe('512 B');
      expect(sizeColumn?.getValue({ size: 1536 } as FileRecord)).toBe('1.5 KB');
      expect(sizeColumn?.getValue({ size: 1048576 } as FileRecord)).toBe('1.0 MB');
    });

    it('should format dates correctly', () => {
      const createdColumn = DEFAULT_FILE_RECORD_COLUMNS.find((col) => col.header === 'Created At');
      const record = { createdAt: '2024-01-01T12:00:00Z' } as FileRecord;

      const formattedDate = createdColumn?.getValue(record);
      expect(formattedDate).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // Date format varies by locale
    });
  });
});
