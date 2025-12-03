import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SearchCollectionContext } from '../search-collection-context';

describe('SearchCollectionContext', () => {
  describe('Collection display', () => {
    it('displays collection name', () => {
      render(<SearchCollectionContext collectionName="Test Collection" />);

      expect(screen.getByText('Searching in:')).toBeInTheDocument();
      expect(screen.getByText('Test Collection')).toBeInTheDocument();
    });

    it('displays indexed chunk count when provided', () => {
      render(<SearchCollectionContext collectionName="Test Collection" indexedChunkCount={42} />);

      expect(screen.getByText(/42 chunks indexed/i)).toBeInTheDocument();
    });

    it('shows singular "chunk" for count of 1', () => {
      render(<SearchCollectionContext collectionName="Test Collection" indexedChunkCount={1} />);

      expect(screen.getByText(/1 chunk indexed/i)).toBeInTheDocument();
    });

    it('formats large chunk counts with locale separator', () => {
      render(<SearchCollectionContext collectionName="Test Collection" indexedChunkCount={1234} />);

      // Check for formatted number (locale-dependent, but should have comma or space)
      const text = screen.getByText(/1,234 chunks indexed/i);
      expect(text).toBeInTheDocument();
    });

    it('does not display chunk count when undefined', () => {
      render(<SearchCollectionContext collectionName="Test Collection" />);

      expect(screen.queryByText(/chunks indexed/i)).not.toBeInTheDocument();
    });
  });

  describe('Help tooltip', () => {
    it('shows info icon', () => {
      const { container } = render(<SearchCollectionContext collectionName="Test Collection" />);

      // Info icon is the tooltip trigger
      const infoIcon = container.querySelector('svg[class*="lucide-info"]');
      expect(infoIcon).toBeInTheDocument();
      expect(infoIcon).toHaveClass('cursor-help');
    });
  });

  describe('Visual elements', () => {
    it('renders file icon', () => {
      const { container } = render(<SearchCollectionContext collectionName="Test Collection" />);

      // FileText icon is rendered
      const svgElements = container.querySelectorAll('svg');
      expect(svgElements.length).toBeGreaterThan(0);
    });

    it('uses badge for collection name', () => {
      render(<SearchCollectionContext collectionName="Test Collection" />);

      const badge = screen.getByText('Test Collection').closest('div');
      expect(badge).toHaveClass('text-xs', 'font-semibold');
    });
  });
});
