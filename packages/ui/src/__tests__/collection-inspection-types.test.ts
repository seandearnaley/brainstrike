// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type CollectionNodeType,
  type DistanceMetric,
  EMBEDDING_STATUS_CONFIG,
  type EmbeddingStatus,
  NODE_TYPE_CONFIG,
} from '../collection-browser/types';

describe('collection inspection types', () => {
  describe('NODE_TYPE_CONFIG', () => {
    it('keeps node categories distinct without assigning status meanings', () => {
      const colors = Object.values(NODE_TYPE_CONFIG).map(({ color }) => color);
      expect(new Set(colors).size).toBe(4);
      for (const color of colors) {
        expect(color).not.toMatch(/text-(?:success|info|warning|destructive)\b/);
        expect(color).toMatch(/dark:text-/);
      }
    });

    it('defines configuration for collection nodes', () => {
      expect(NODE_TYPE_CONFIG.collection).toBeDefined();
      expect(NODE_TYPE_CONFIG.collection.label).toBe('Collection');
    });

    it('defines configuration for file nodes', () => {
      expect(NODE_TYPE_CONFIG.file).toBeDefined();
      expect(NODE_TYPE_CONFIG.file.label).toBe('File');
    });

    it('defines configuration for chunk nodes', () => {
      expect(NODE_TYPE_CONFIG.chunk).toBeDefined();
      expect(NODE_TYPE_CONFIG.chunk.label).toBe('Chunk');
    });

    it('defines configuration for embedding nodes', () => {
      expect(NODE_TYPE_CONFIG.embedding).toBeDefined();
      expect(NODE_TYPE_CONFIG.embedding.label).toBe('Embedding');
    });

    it('all node types have required properties', () => {
      const nodeTypes: CollectionNodeType[] = ['collection', 'file', 'chunk', 'embedding'];
      for (const nodeType of nodeTypes) {
        const config = NODE_TYPE_CONFIG[nodeType];
        expect(config.label).toBeDefined();
        expect(typeof config.label).toBe('string');
      }
    });
  });

  describe('EMBEDDING_STATUS_CONFIG', () => {
    it('defines configuration for pending status', () => {
      expect(EMBEDDING_STATUS_CONFIG.pending).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.pending.label).toBe('Pending');
    });

    it('defines configuration for processing status', () => {
      expect(EMBEDDING_STATUS_CONFIG.processing).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.processing.label).toBe('Processing');
    });

    it('defines configuration for complete status', () => {
      expect(EMBEDDING_STATUS_CONFIG.complete).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.complete.label).toBe('Complete');
    });

    it('defines configuration for failed status', () => {
      expect(EMBEDDING_STATUS_CONFIG.failed).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.failed.label).toBe('Failed');
    });

    it('defines configuration for none status', () => {
      expect(EMBEDDING_STATUS_CONFIG.none).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.none.label).toBe('No Embedding');
    });

    it('defines configuration for all status filter', () => {
      expect(EMBEDDING_STATUS_CONFIG.all).toBeDefined();
      expect(EMBEDDING_STATUS_CONFIG.all.label).toBe('All Status');
    });

    it('all status types have required properties', () => {
      const statuses: EmbeddingStatus[] = ['pending', 'processing', 'complete', 'failed', 'none'];
      for (const status of statuses) {
        const config = EMBEDDING_STATUS_CONFIG[status];
        expect(config.label).toBeDefined();
        expect(typeof config.label).toBe('string');
      }
    });
  });

  describe('type definitions', () => {
    it('DistanceMetric type includes expected values', () => {
      const metrics: DistanceMetric[] = ['cosine', 'l2', 'ip'];
      expect(metrics.length).toBe(3);
    });

    it('CollectionNodeType includes all expected values', () => {
      const types: CollectionNodeType[] = ['collection', 'file', 'chunk', 'embedding'];
      expect(types.length).toBe(4);
    });

    it('EmbeddingStatus includes all expected values', () => {
      const statuses: EmbeddingStatus[] = ['pending', 'processing', 'complete', 'failed', 'none'];
      expect(statuses.length).toBe(5);
    });
  });
});
