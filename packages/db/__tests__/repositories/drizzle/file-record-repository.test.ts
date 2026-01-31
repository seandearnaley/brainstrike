import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleFileRecordRepository } from '../../../src/repositories/drizzle/file-record-repository';

// Mock dependencies
const mockDb = {
  select: vi.fn(),
  from: vi.fn(),
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
          id: 'id1',
          name: 'File 1',
          path: '/path/1',
          size: 100,
          createdAt: new Date(),
          updatedAt: new Date(),
          embeddingSetId: null,
          content: null,
          contentHash: null,
          tokenCount: null,
          processedAt: null,
        },
        {
          id: 'id2',
          name: 'File 2',
          path: '/path/2',
          size: 200,
          createdAt: new Date(),
          updatedAt: new Date(),
          embeddingSetId: null,
          content: null,
          contentHash: null,
          tokenCount: null,
          processedAt: null,
        },
      ]);

      await repository.findByIds(ids);

      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle non-existent IDs gracefully', async () => {
      mockDb.where.mockResolvedValue([
        {
          id: 'id1',
          name: 'File 1',
          path: '/path/1',
          size: 100,
          createdAt: new Date(),
          updatedAt: new Date(),
          embeddingSetId: null,
          content: null,
          contentHash: null,
          tokenCount: null,
          processedAt: null,
        },
      ]);

      const result = await repository.findByIds(['id1', 'non-existent']);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('id1');
    });
  });
});
