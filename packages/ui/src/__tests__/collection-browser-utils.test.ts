import { describe, expect, it } from 'vitest';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionData,
  EmbeddingData,
  FileData,
} from '../collection-browser/types';
import { getNodeDisplayInfo } from '../collection-browser/utils';

describe('getNodeDisplayInfo', () => {
  it('formats collection nodes', () => {
    const collection: CollectionData = {
      chunkCount: 12,
      createdAt: new Date(),
      dimensions: 384,
      embeddingCount: 12,
      fileCount: 3,
      modelId: 'local:test',
      name: 'Docs',
    };

    expect(getNodeDisplayInfo('collection', collection)).toEqual({
      displayName: 'Docs',
      subtitle: '3 files • 12 chunks',
    });
  });

  it('formats file nodes with a shortened path', () => {
    const file: FileData = {
      chunkCount: 2,
      embeddingStatus: 'complete',
      importedAt: new Date(),
      name: 'index.ts',
      path: '/Users/sean/projects/brainstrike/packages/app-shell/src/index.ts',
      size: 512,
    };
    const result = getNodeDisplayInfo('file', file);

    expect(result.displayName).toBe('index.ts');
    expect(result.subtitle).toContain('index.ts');
  });

  it('formats chunk nodes and truncates long content', () => {
    const chunk: ChunkData = {
      content: 'a'.repeat(80),
      embeddingStatus: 'processing',
      index: 7,
      tokenCount: 30,
    };
    const result = getNodeDisplayInfo('chunk', chunk);

    expect(result.displayName).toBe('Chunk #7');
    expect(result.subtitle).toHaveLength(63);
    expect(result.subtitle.endsWith('...')).toBe(true);
  });

  it('formats embedding nodes', () => {
    const embedding: EmbeddingData = {
      dimensions: 384,
      vectorId: 'embedding-1',
    };

    expect(getNodeDisplayInfo('embedding', embedding)).toEqual({
      displayName: 'Vector',
      subtitle: '384 dimensions',
    });
  });

  it('returns empty display info for unknown node types', () => {
    expect(getNodeDisplayInfo('mystery', {} as BrowserNodeData)).toEqual({
      displayName: '',
      subtitle: '',
    });
  });
});
