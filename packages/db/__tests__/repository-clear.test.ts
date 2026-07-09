import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseFileRecordRepository } from '../src/repositories/base-repository';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository';
import type { IDatabase } from '../src/repositories/interfaces';

describe('Repository clearAll functionality', () => {
  let mockDb: IDatabase & {
    transaction: NonNullable<IDatabase['transaction']>;
  };
  let fileRepository: BaseFileRecordRepository;
  let chunkRepository: FileChunkRepository;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
      transaction: vi.fn(async (fn) => fn({ query: vi.fn() })),
    };
    fileRepository = new BaseFileRecordRepository(mockDb, 'file_records');
    chunkRepository = new FileChunkRepository(mockDb);
  });

  describe('BaseFileRecordRepository clearAll', () => {
    it('should count records before deletion', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // COUNT query
        .mockResolvedValueOnce({ rows: [] }); // DELETE query

      const result = await fileRepository.clearAll();

      expect(mockQuery).toHaveBeenNthCalledWith(1, 'SELECT COUNT(*) as count FROM file_records');
      expect(mockQuery).toHaveBeenNthCalledWith(2, 'DELETE FROM file_records');
      expect(result).toBe(5);
    });

    it('should handle zero records', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(0);
    });

    it('should handle missing count value', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{}] }) // No count property
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(0);
    });

    it('should handle empty result rows', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // Empty rows
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(0);
    });

    it('should throw error on database failure', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery.mockRejectedValue(new Error('Database connection failed'));

      await expect(fileRepository.clearAll()).rejects.toThrow('Database connection failed');
    });

    it('should throw error on DELETE failure after successful COUNT', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockRejectedValueOnce(new Error('DELETE failed'));

      await expect(fileRepository.clearAll()).rejects.toThrow('DELETE failed');
    });
  });

  describe('FileChunkRepository clearAll', () => {
    it('should clear chunks from correct table', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await chunkRepository.clearAll();

      expect(mockQuery).toHaveBeenNthCalledWith(1, 'SELECT COUNT(*) as count FROM file_chunks');
      expect(mockQuery).toHaveBeenNthCalledWith(2, 'DELETE FROM file_chunks');
      expect(result).toBe(10);
    });
  });

  describe('Integration scenarios', () => {
    it('should clear chunks before files (foreign key constraint)', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;

      // Mock chunk clearing
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '15' }] }) // chunk count
        .mockResolvedValueOnce({ rows: [] }); // chunk delete

      const chunksDeleted = await chunkRepository.clearAll();
      expect(chunksDeleted).toBe(15);

      // Then mock file clearing
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // file count
        .mockResolvedValueOnce({ rows: [] }); // file delete

      const filesDeleted = await fileRepository.clearAll();
      expect(filesDeleted).toBe(5);

      // Verify order of operations
      expect(mockQuery).toHaveBeenNthCalledWith(1, 'SELECT COUNT(*) as count FROM file_chunks');
      expect(mockQuery).toHaveBeenNthCalledWith(2, 'DELETE FROM file_chunks');
      expect(mockQuery).toHaveBeenNthCalledWith(3, 'SELECT COUNT(*) as count FROM file_records');
      expect(mockQuery).toHaveBeenNthCalledWith(4, 'DELETE FROM file_records');
    });

    it('should handle large dataset clearing', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1000000' }] }) // Large count
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(1_000_000);
    });

    it('should handle string count values correctly', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '42' }] }) // String count
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(42);
    });

    it('should handle numeric count values correctly', async () => {
      const mockQuery = mockDb.query as ReturnType<typeof vi.fn>;
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: 42 }] }) // Numeric count
        .mockResolvedValueOnce({ rows: [] });

      const result = await fileRepository.clearAll();

      expect(result).toBe(42);
    });
  });
});
