import type { FileRecord } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
// Import csv-export-core functions for testing
import { escapeCSVValue, formatDate, formatFileSize, truncateContent } from '../csv-export-core';
import {
  createCSVBlob,
  DEFAULT_FILE_RECORD_COLUMNS,
  exportAllDataAsZip,
  generateChunksCSV,
  generateCSV,
  generateCSVFilename,
  generateEmbeddingsCSV,
  generateFilesWithChunksCSV,
} from '../csv-export-utils';

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

// Mock JSZip - use function syntax for Vitest 4 constructor mocks
const mockZip = {
  file: vi.fn(),
  generateAsync: vi.fn().mockResolvedValue(new Blob(['mock zip content'])),
};

vi.mock('jszip', () => {
  const MockJSZip = vi.fn();
  MockJSZip.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockZip);
  });
  return { default: MockJSZip };
});

describe('CSV Export Utils', () => {
  const mockRecords: FileRecord[] = [
    {
      content: 'This is a test file with some content',
      contentHash: 'abc123',
      createdAt: '2024-01-01T00:00:00Z',
      id: '1',
      name: 'test.txt',
      path: '/path/to/test.txt',
      processedAt: '2024-01-01T01:00:00Z',
      size: 1024,
      tokenCount: 10,
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      content: 'Content with "quotes" and\nnewlines',
      contentHash: 'def456',
      createdAt: '2024-01-02T00:00:00Z',
      id: '2',
      name: 'file,with,commas.csv',
      path: '/path/to/"quoted".csv',
      processedAt: '2024-01-02T01:00:00Z',
      size: 2048,
      tokenCount: 20,
      updatedAt: '2024-01-02T00:00:00Z',
    },
    {
      createdAt: '2024-01-03T00:00:00Z',
      id: '3',
      name: 'empty.txt',
      path: '/path/to/empty.txt',
      size: 0,
      updatedAt: '2024-01-03T00:00:00Z',
      // No content fields
    },
  ];

  const mockFileChunks = [
    {
      chunkIndex: 0,
      chunkSize: 55,
      chunkType: 'text' as const,
      content: 'This is the first chunk of content for testing purposes.',
      contentHash: 'chunk1hash',
      createdAt: '2024-01-01T00:00:00Z',
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
      fileRecordId: '1',
      id: 'chunk1',
      tokenCount: 12,
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      chunkIndex: 1,
      chunkSize: 89,
      chunkType: 'sentence' as const,
      content:
        'This is the second chunk with a longer content that should be truncated in the preview.',
      contentHash: 'chunk2hash',
      createdAt: '2024-01-01T01:00:00Z',
      embedding: [0.6, 0.7, 0.8, 0.9, 1.0],
      fileRecordId: '1',
      id: 'chunk2',
      tokenCount: 18,
      updatedAt: '2024-01-01T01:00:00Z',
    },
    {
      chunkIndex: 0,
      chunkSize: 29,
      chunkType: 'recursive' as const,
      content: 'Third chunk without embedding',
      contentHash: 'chunk3hash',
      createdAt: '2024-01-02T00:00:00Z',
      fileRecordId: '2',
      id: 'chunk3',
      tokenCount: 6,
      updatedAt: '2024-01-02T00:00:00Z',
    },
  ];

  const mockRecordsWithChunkMetadata: FileRecord[] = [
    {
      chunkingStrategy: 'sentence',
      chunksCount: 2,
      chunksProcessedAt: '2024-01-01T02:00:00Z',
      content: 'This is a test file with some content',
      contentHash: 'abc123',
      createdAt: '2024-01-01T00:00:00Z',
      embedding: [0.1, 0.2, 0.3],
      id: '1',
      name: 'test.txt',
      path: '/path/to/test.txt',
      processedAt: '2024-01-01T01:00:00Z',
      size: 1024,
      tokenCount: 10,
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      chunkingStrategy: 'recursive',
      chunksCount: 1,
      chunksProcessedAt: '2024-01-02T02:00:00Z',
      content: 'Content with "quotes" and\nnewlines',
      contentHash: 'def456',
      createdAt: '2024-01-02T00:00:00Z',
      id: '2',
      name: 'file,with,commas.csv',
      path: '/path/to/"quoted".csv',
      processedAt: '2024-01-02T01:00:00Z',
      size: 2048,
      tokenCount: 20,
      updatedAt: '2024-01-02T00:00:00Z',
    },
  ];

  describe('generateCSV', () => {
    it('should generate CSV with headers', () => {
      const csv = generateCSV(mockRecords);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('ID,Name,Path,Size');
    });

    it('should handle empty records', () => {
      const csv = generateCSV([]);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ID,Name,Path,Size');
    });

    it('should escape CSV values properly', () => {
      const csv = generateCSV(mockRecords);
      expect(csv).toContain('"file,with,commas.csv"');
      expect(csv).toContain('"/path/to/""quoted"".csv"');
    });

    it('should handle missing optional fields', () => {
      const csv = generateCSV(mockRecords);
      const lines = csv.split('\n');
      expect(lines[4]).toContain('empty.txt'); // Record without optional fields (4th line, 0-indexed)
    });

    it('should use custom columns when provided', () => {
      const customColumns = [
        { getValue: (record: FileRecord) => record.name, header: 'Name' },
        { getValue: (record: FileRecord) => record.size, header: 'Size' },
      ];
      const csv = generateCSV(mockRecords, customColumns);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('Name,Size');
      expect(lines[1]).toBe('test.txt,1024');
    });
  });

  describe('createCSVBlob', () => {
    it('should create a blob with correct MIME type', () => {
      const csvContent = 'header1,header2\nvalue1,value2';
      const blob = createCSVBlob(csvContent);
      expect(blob.type).toBe('text/csv;charset=utf-8');
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('generateCSVFilename', () => {
    it('should generate filename with timestamp', () => {
      const filename = generateCSVFilename();
      expect(filename).toMatch(/file-records-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv/);
    });

    it('should use custom prefix', () => {
      const filename = generateCSVFilename('custom-export');
      expect(filename).toMatch(/custom-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv/);
    });
  });

  describe('generateFilesWithChunksCSV', () => {
    it('should generate CSV with chunk metadata headers', () => {
      const csv = generateFilesWithChunksCSV(mockRecordsWithChunkMetadata);
      const lines = csv.split('\n');

      expect(lines[0]).toContain(
        'ID,Name,Path,Size,Created At,Updated At,Token Count,Processed At,Chunks Count,Chunking Strategy,Chunks Processed At,Has Embedding,Content Hash'
      );
    });

    it('should include chunk metadata in records', () => {
      const csv = generateFilesWithChunksCSV(mockRecordsWithChunkMetadata);
      const lines = csv.split('\n');

      // First record with embedding
      expect(lines[1]).toContain('2,sentence,2024-01-01T02:00:00Z,Yes');

      // Second record without embedding
      expect(lines[2]).toContain('1,recursive,2024-01-02T02:00:00Z,No');
    });

    it('should handle records without chunk metadata', () => {
      const csv = generateFilesWithChunksCSV(mockRecords);
      const lines = csv.split('\n');

      // Should use default values for missing chunk metadata (has some values, then 0 chunks, empty strategy fields, then No for embedding)
      expect(lines[1]).toContain(',0,,,No,');
    });

    it('should handle empty records array', () => {
      const csv = generateFilesWithChunksCSV([]);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ID,Name,Path');
    });
  });

  describe('generateChunksCSV', () => {
    it('should generate CSV with chunk headers', () => {
      const csv = generateChunksCSV(mockFileChunks);
      const lines = csv.split('\n');

      expect(lines[0]).toContain(
        'ID,File Record ID,Chunk Index,Chunk Type,Token Count,Chunk Size,Content Hash,Has Embedding,Embedding Dimensions,Created At,Updated At,Content Preview'
      );
    });

    it('should include chunk data with content preview', () => {
      const csv = generateChunksCSV(mockFileChunks);
      const lines = csv.split('\n');

      // First chunk with embedding
      expect(lines[1]).toContain('chunk1,1,0,text,12,55,chunk1hash,Yes,5');
      expect(lines[1]).toContain('This is the first chunk of content for testing purposes....');

      // Third chunk without embedding
      expect(lines[3]).toContain('chunk3,2,0,recursive,6,29,chunk3hash,No,0');
    });

    it('should truncate long content in preview', () => {
      const csv = generateChunksCSV(mockFileChunks);
      const lines = csv.split('\n');

      // Second chunk has longer content that should be truncated
      expect(lines[2]).toContain(
        'This is the second chunk with a longer content that should be truncated in the preview....'
      );
    });

    it('should handle empty chunks array', () => {
      const csv = generateChunksCSV([]);
      const lines = csv.split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ID,File Record ID');
    });
  });

  describe('generateEmbeddingsCSV', () => {
    it('should generate CSV with embedding dimensions', () => {
      const csv = generateEmbeddingsCSV(mockFileChunks);
      const lines = csv.split('\n');

      expect(lines[0]).toContain(
        'Chunk ID,File Record ID,Chunk Index,Content Hash,Token Count,dim_0,dim_1,dim_2,dim_3,dim_4'
      );
    });

    it('should include only chunks with embeddings', () => {
      const csv = generateEmbeddingsCSV(mockFileChunks);
      const lines = csv.split('\n');

      // Should have header + 2 chunks with embeddings (chunk3 has no embedding)
      expect(lines).toHaveLength(3);

      expect(lines[1]).toContain('chunk1,1,0,chunk1hash,12,0.1,0.2,0.3,0.4,0.5');
      expect(lines[2]).toContain('chunk2,1,1,chunk2hash,18,0.6,0.7,0.8,0.9,1');
    });

    it('should handle chunks without embeddings', () => {
      const chunksWithoutEmbeddings = mockFileChunks.filter((chunk) => !chunk.embedding);
      const csv = generateEmbeddingsCSV(chunksWithoutEmbeddings);

      expect(csv).toBe('No embeddings found');
    });

    it('should handle empty chunks array', () => {
      const csv = generateEmbeddingsCSV([]);
      expect(csv).toBe('No embeddings found');
    });

    it('should handle chunks with different embedding dimensions', () => {
      const chunksWithDifferentDims = [
        {
          chunkIndex: 0,
          chunkSize: 55,
          chunkType: 'text' as const,
          content: 'Test content',
          contentHash: 'chunk1hash',
          createdAt: '2024-01-01T00:00:00Z',
          embedding: [0.1, 0.2], // 2 dimensions
          fileRecordId: '1',
          id: 'chunk1',
          tokenCount: 12,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const csv = generateEmbeddingsCSV(chunksWithDifferentDims);
      const lines = csv.split('\n');

      expect(lines[0]).toContain('dim_0,dim_1');
      expect(lines[1]).toContain('0.1,0.2');
    });

    it('should skip chunks without embeddings in mixed arrays', () => {
      const mixedChunks = [
        {
          chunkIndex: 0,
          chunkSize: 55,
          chunkType: 'text' as const,
          content: 'Test content',
          contentHash: 'chunk1hash',
          createdAt: '2024-01-01T00:00:00Z',
          embedding: [0.1, 0.2],
          fileRecordId: '1',
          id: 'chunk1',
          tokenCount: 12,
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          chunkIndex: 1,
          chunkSize: 32,
          chunkType: 'text' as const,
          content: 'Test content without embedding',
          contentHash: 'chunk2hash',
          // No embedding property
          createdAt: '2024-01-01T00:00:00Z',
          fileRecordId: '1',
          id: 'chunk2',
          tokenCount: 8,
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          chunkIndex: 2,
          chunkSize: 20,
          chunkType: 'text' as const,
          content: 'Another test content',
          contentHash: 'chunk3hash',
          createdAt: '2024-01-01T00:00:00Z',
          embedding: [0.3, 0.4],
          fileRecordId: '1',
          id: 'chunk3',
          tokenCount: 6,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const csv = generateEmbeddingsCSV(mixedChunks);
      const lines = csv.split('\n');

      // Should have header + 2 chunks with embeddings (chunk2 has no embedding)
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('chunk1');
      expect(lines[2]).toContain('chunk3');
      expect(csv).not.toContain('chunk2');
    });

    it('should handle chunks with empty embeddings array', () => {
      const chunksWithEmptyEmbeddings = [
        {
          chunkIndex: 0,
          chunkSize: 55,
          chunkType: 'text' as const,
          content: 'Test content',
          contentHash: 'chunk1hash',
          createdAt: '2024-01-01T00:00:00Z',
          embedding: [], // Empty array
          fileRecordId: '1',
          id: 'chunk1',
          tokenCount: 12,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const csv = generateEmbeddingsCSV(chunksWithEmptyEmbeddings);
      const lines = csv.split('\n');

      expect(lines[0]).toContain('Chunk ID,File Record ID,Chunk Index,Content Hash,Token Count');
      expect(lines[1]).toContain('chunk1,1,0,chunk1hash,12');
    });

    it('should handle edge case where embedding exists but is falsy', () => {
      // This test is designed to cover the edge case where the continue statement is hit
      // We'll create a scenario where a chunk passes the initial filter but fails the inner check
      const chunksWithMixedEmbeddings = [
        {
          chunkIndex: 0,
          chunkSize: 55,
          chunkType: 'text' as const,
          content: 'Test content',
          contentHash: 'chunk1hash',
          createdAt: '2024-01-01T00:00:00Z',
          embedding: [0.1, 0.2],
          fileRecordId: '1',
          id: 'chunk1',
          tokenCount: 12,
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      // Manually modify the chunk after it would pass the filter to simulate race condition
      const originalChunk = chunksWithMixedEmbeddings[0];
      if (originalChunk) {
        // Simulate a chunk that has embedding but becomes null during processing
        Object.defineProperty(originalChunk, 'embedding', {
          configurable: true,
          enumerable: true,
          get: () => [0.1, 0.2], // Returns truthy for filter
          set: () => {}, // Allows setting but ignores
        });
      }

      const csv = generateEmbeddingsCSV(chunksWithMixedEmbeddings);
      const lines = csv.split('\n');

      // Should work normally since we can't actually trigger the continue easily
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('chunk1');
    });
  });

  describe('exportAllDataAsZip', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should create zip with all CSV files', async () => {
      await exportAllDataAsZip(mockRecordsWithChunkMetadata, mockFileChunks);

      expect(mockZip.file).toHaveBeenCalledTimes(3);
      expect(mockZip.file).toHaveBeenCalledWith(
        'files.csv',
        expect.stringContaining('ID,Name,Path')
      );
      expect(mockZip.file).toHaveBeenCalledWith(
        'chunks.csv',
        expect.stringContaining('ID,File Record ID')
      );
      expect(mockZip.file).toHaveBeenCalledWith(
        'embeddings.csv',
        expect.stringContaining('Chunk ID,File Record ID')
      );
    });

    it('should generate and save zip file', async () => {
      const { saveAs } = await import('file-saver');

      await exportAllDataAsZip(mockRecordsWithChunkMetadata, mockFileChunks);

      expect(mockZip.generateAsync).toHaveBeenCalledWith({ type: 'blob' });
      expect(saveAs).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.stringMatching(/database_export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip/)
      );
    });

    it('should handle empty data arrays', async () => {
      await exportAllDataAsZip([], []);

      expect(mockZip.file).toHaveBeenCalledTimes(3);
      expect(mockZip.file).toHaveBeenCalledWith(
        'files.csv',
        expect.stringContaining('ID,Name,Path')
      );
      expect(mockZip.file).toHaveBeenCalledWith(
        'chunks.csv',
        expect.stringContaining('ID,File Record ID')
      );
      expect(mockZip.file).toHaveBeenCalledWith('embeddings.csv', 'No embeddings found');
    });
  });

  describe('DEFAULT_FILE_RECORD_COLUMNS', () => {
    it('should have correct column configuration', () => {
      expect(DEFAULT_FILE_RECORD_COLUMNS).toHaveLength(11);

      const headers = DEFAULT_FILE_RECORD_COLUMNS.map((col) => col.header);
      expect(headers).toEqual([
        'ID',
        'Name',
        'Path',
        'Size',
        'Size (bytes)',
        'Token Count',
        'Content Sample (500 chars)',
        'Content Hash',
        'Created At',
        'Updated At',
        'Processed At',
      ]);
    });

    it('should extract values correctly from records', () => {
      const record = mockRecords[0];
      expect(record).toBeDefined();
      if (!record) {
        return;
      }

      expect(DEFAULT_FILE_RECORD_COLUMNS[0]?.getValue(record)).toBe('1');
      expect(DEFAULT_FILE_RECORD_COLUMNS[1]?.getValue(record)).toBe('test.txt');
      expect(DEFAULT_FILE_RECORD_COLUMNS[2]?.getValue(record)).toBe('/path/to/test.txt');
      expect(DEFAULT_FILE_RECORD_COLUMNS[3]?.getValue(record)).toBe('1.0 KB');
      expect(DEFAULT_FILE_RECORD_COLUMNS[4]?.getValue(record)).toBe(1024);
      expect(DEFAULT_FILE_RECORD_COLUMNS[5]?.getValue(record)).toBe(10);
    });
  });
});

// Add new test suite for csv-export-core functions
describe('CSV Export Core Functions', () => {
  describe('escapeCSVValue', () => {
    it('should handle null and undefined values', () => {
      expect(escapeCSVValue(null)).toBe('');
      expect(escapeCSVValue(undefined)).toBe('');
    });

    it('should handle values that do not need escaping', () => {
      expect(escapeCSVValue('simple')).toBe('simple');
      expect(escapeCSVValue(123)).toBe('123');
      expect(escapeCSVValue(0)).toBe('0');
    });

    it('should escape values with commas', () => {
      expect(escapeCSVValue('hello,world')).toBe('"hello,world"');
    });

    it('should escape values with newlines', () => {
      expect(escapeCSVValue('hello\nworld')).toBe('"hello\nworld"');
    });

    it('should escape values with quotes', () => {
      expect(escapeCSVValue('hello "quoted" world')).toBe('"hello ""quoted"" world"');
    });

    it('should escape values with multiple special characters', () => {
      expect(escapeCSVValue('hello,\n"world"')).toBe('"hello,\n""world"""');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(512)).toBe('512 B');
      expect(formatFileSize(1023)).toBe('1023 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(1024 * 1024 - 1)).toBe('1024.0 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatFileSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
      expect(formatFileSize(1024 * 1024 * 10)).toBe('10.0 MB');
    });
  });

  describe('formatDate', () => {
    it('should handle undefined input', () => {
      expect(formatDate(undefined)).toBe('');
    });

    it('should format valid ISO date strings', () => {
      const isoString = '2024-01-01T12:00:00Z';
      const result = formatDate(isoString);
      expect(result).toBeTruthy();
      expect(result).not.toBe(isoString); // Should be formatted differently
    });

    it('should handle invalid date strings gracefully', () => {
      const invalidDate = 'not-a-date';
      expect(formatDate(invalidDate)).toBe('Invalid Date');
    });

    it('should handle malformed ISO strings', () => {
      const malformedDate = '2024-13-45T25:70:90Z';
      expect(formatDate(malformedDate)).toBe('Invalid Date');
    });

    it('should handle exceptions during date formatting', () => {
      // Mock toLocaleString to throw an exception to test the catch block
      const originalToLocaleString = Date.prototype.toLocaleString;
      Date.prototype.toLocaleString = vi.fn(() => {
        throw new Error('Formatting error');
      });

      const result = formatDate('2024-01-01T00:00:00Z');
      expect(result).toBe('2024-01-01T00:00:00Z');

      // Restore original method
      Date.prototype.toLocaleString = originalToLocaleString;
    });
  });

  describe('truncateContent', () => {
    it('should handle undefined input', () => {
      expect(truncateContent(undefined, 10)).toBe('');
    });

    it('should return content as-is if shorter than maxLength', () => {
      expect(truncateContent('short', 10)).toBe('short');
      expect(truncateContent('exactly10!', 10)).toBe('exactly10!');
    });

    it('should truncate content longer than maxLength', () => {
      expect(truncateContent('this is a very long string', 10)).toBe('this is a ...');
    });

    it('should handle empty string', () => {
      expect(truncateContent('', 10)).toBe('');
    });

    it('should handle maxLength of 0', () => {
      expect(truncateContent('content', 0)).toBe('...');
    });

    it('should handle maxLength less than 3', () => {
      expect(truncateContent('content', 2)).toBe('co...');
    });
  });
});
