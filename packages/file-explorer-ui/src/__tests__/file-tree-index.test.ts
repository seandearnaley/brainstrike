import { describe, expect, it } from 'vitest';
import { FileTreeIndex } from '../file-tree-index';

describe('FileTreeIndex', () => {
  it('should create an empty index', () => {
    const index = new FileTreeIndex();
    expect(index.stats).toEqual({
      totalNodes: 0,
      totalFiles: 0,
      totalDirectories: 0,
    });
  });
});
