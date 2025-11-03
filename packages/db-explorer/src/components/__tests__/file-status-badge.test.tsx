import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FileCollectionStatus } from '../../types/file-collection-status';
import { FileStatusBadge } from '../file-status-badge';

describe('FileStatusBadge', () => {
  const activeCollectionName = 'Test Collection';

  const createStatus = (overrides?: Partial<FileCollectionStatus>): FileCollectionStatus => ({
    fileId: 'file-1',
    fileName: 'test.ts',
    filePath: '/test/path/test.ts',
    searchableInActive: false,
    searchableChunksCount: 0,
    totalChunksCount: 0,
    otherCollectionsCount: 0,
    ...overrides,
  });

  describe('Searchable status', () => {
    it('shows searchable badge when file has embeddings in active collection', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 5,
        totalChunksCount: 5,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/searchable in this collection/i)).toBeInTheDocument();
      expect(screen.getByText(/5 chunks/i)).toBeInTheDocument();
    });

    it('shows singular "chunk" for single chunk', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 1,
        totalChunksCount: 1,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/1 chunk$/i)).toBeInTheDocument();
    });

    it('shows last indexed time when available', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        totalChunksCount: 3,
        lastIndexedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/last indexed/i)).toBeInTheDocument();
      expect(screen.getByText(/5 minutes ago/i)).toBeInTheDocument();
    });

    it('shows other collections count when file is in multiple collections', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        totalChunksCount: 3,
        otherCollectionsCount: 2,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/also in 2 other collections/i)).toBeInTheDocument();
    });

    it('shows singular "collection" for one other collection', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        totalChunksCount: 3,
        otherCollectionsCount: 1,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/also in 1 other collection$/i)).toBeInTheDocument();
    });
  });

  describe('Not searchable status', () => {
    it('shows not searchable badge when file has no embeddings', () => {
      const status = createStatus({
        searchableInActive: false,
        searchableChunksCount: 0,
        totalChunksCount: 5,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/not yet searchable/i)).toBeInTheDocument();
    });

    it('shows chunk count and needs indexing message', () => {
      const status = createStatus({
        searchableInActive: false,
        searchableChunksCount: 0,
        totalChunksCount: 10,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/10 chunks created/i)).toBeInTheDocument();
      expect(screen.getByText(/needs indexing/i)).toBeInTheDocument();
    });

    it('shows singular "chunk" for single chunk not indexed', () => {
      const status = createStatus({
        searchableInActive: false,
        searchableChunksCount: 0,
        totalChunksCount: 1,
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/1 chunk created/i)).toBeInTheDocument();
    });
  });

  describe('Relative time formatting', () => {
    it('shows "just now" for very recent timestamps', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        lastIndexedAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30 seconds ago
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('shows minutes for recent timestamps', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        lastIndexedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 minutes ago
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/15 minutes ago/i)).toBeInTheDocument();
    });

    it('shows hours for timestamps within 24 hours', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        lastIndexedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/5 hours ago/i)).toBeInTheDocument();
    });

    it('shows days for timestamps within a week', () => {
      const status = createStatus({
        searchableInActive: true,
        searchableChunksCount: 3,
        lastIndexedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
      });

      render(<FileStatusBadge status={status} activeCollectionName={activeCollectionName} />);

      expect(screen.getByText(/3 days ago/i)).toBeInTheDocument();
    });
  });
});
