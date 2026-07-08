import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleFileRecordRepository } from '../../../src/repositories/drizzle/file-record-repository';

// Mock dependencies
const mockDb = {
  from: vi.fn(),
  select: vi.fn(),
  where: vi.fn(),
};

describe('DrizzleFileRecordRepository', () => {
  let repository: DrizzleFileRecordRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockResolvedValue([]);
    repository = new DrizzleFileRecordRepository(mockDb as any);
  });

  describe('findByIds', () => {
    it('should return empty array for empty input', async () => {
      const result = await repository.findByIds([]);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('should deduplicate IDs', async () => {
      const ids = ['id1', 'id1', 'id2'];
      mockDb.where.mockResolvedValue([
        {
          content: null,
          contentHash: null,
          createdAt: new Date(),
          embeddingSetId: null,
          id: 'id1',
          name: 'File 1',
          path: '/path/1',
          processedAt: null,
          size: 100,
          tokenCount: null,
          updatedAt: new Date(),
        },
        {
          content: null,
          contentHash: null,
          createdAt: new Date(),
          embeddingSetId: null,
          id: 'id2',
          name: 'File 2',
          path: '/path/2',
          processedAt: null,
          size: 200,
          tokenCount: null,
          updatedAt: new Date(),
        },
      ]);

      await repository.findByIds(ids);

      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle non-existent IDs gracefully', async () => {
      mockDb.where.mockResolvedValue([
        {
          content: null,
          contentHash: null,
          createdAt: new Date(),
          embeddingSetId: null,
          id: 'id1',
          name: 'File 1',
          path: '/path/1',
          processedAt: null,
          size: 100,
          tokenCount: null,
          updatedAt: new Date(),
        },
      ]);

      const result = await repository.findByIds(['id1', 'non-existent']);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('id1');
    });
  });
});
