import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FileCollectionStatus } from '../../types/file-collection-status';
import { FileActionButtons } from '../file-action-buttons';

describe('FileActionButtons', () => {
  const createStatus = (overrides?: Partial<FileCollectionStatus>): FileCollectionStatus => ({
    fileId: 'file-1',
    fileName: 'test.ts',
    filePath: '/test/path/test.ts',
    otherCollectionsCount: 0,
    searchableChunksCount: 0,
    searchableInActive: false,
    totalChunksCount: 0,
    ...overrides,
  });

  describe('Make Searchable button', () => {
    it('shows "Make Searchable" button for non-searchable files with chunks', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 5,
      });

      render(<FileActionButtons status={status} />);

      expect(screen.getByRole('button', { name: /make.*searchable/i })).toBeInTheDocument();
    });

    it('does not show button for files without chunks', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 0,
      });

      render(<FileActionButtons status={status} />);

      expect(screen.queryByRole('button', { name: /make.*searchable/i })).not.toBeInTheDocument();
    });

    it('button is disabled when no handler provided', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 5,
      });

      render(<FileActionButtons status={status} />);

      const button = screen.getByRole('button', { name: /make.*searchable/i });
      expect(button).toBeDisabled();
    });

    it('button is enabled when handler provided', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 5,
      });
      const onMakeSearchable = vi.fn();

      render(<FileActionButtons onMakeSearchable={onMakeSearchable} status={status} />);

      const button = screen.getByRole('button', { name: /make.*searchable/i });
      expect(button).not.toBeDisabled();
    });

    it('calls handler when clicked', async () => {
      const user = userEvent.setup();
      const status = createStatus({
        fileId: 'test-file-id',
        searchableInActive: false,
        totalChunksCount: 5,
      });
      const onMakeSearchable = vi.fn();

      render(<FileActionButtons onMakeSearchable={onMakeSearchable} status={status} />);

      const button = screen.getByRole('button', { name: /make.*searchable/i });
      await user.click(button);

      expect(onMakeSearchable).toHaveBeenCalledWith('test-file-id');
      expect(onMakeSearchable).toHaveBeenCalledTimes(1);
    });

    it('shows "coming soon" tooltip when disabled', async () => {
      const user = userEvent.setup();
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 5,
      });

      render(<FileActionButtons status={status} />);

      const button = screen.getByRole('button', { name: /make.*searchable/i });
      await user.hover(button);

      // Tooltip should explain feature is coming (Radix UI may duplicate for a11y)
      expect(await screen.findAllByText(/coming soon/i)).toHaveLength(2);
    });
  });

  describe('Re-index button', () => {
    it('shows "Re-index" button for searchable files', () => {
      const status = createStatus({
        searchableChunksCount: 5,
        searchableInActive: true,
      });

      render(<FileActionButtons status={status} />);

      expect(screen.getByRole('button', { name: /re-index/i })).toBeInTheDocument();
    });

    it('does not show button for non-searchable files', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 5,
      });

      render(<FileActionButtons status={status} />);

      expect(screen.queryByRole('button', { name: /re-index/i })).not.toBeInTheDocument();
    });

    it('button is disabled when no handler provided', () => {
      const status = createStatus({
        searchableChunksCount: 5,
        searchableInActive: true,
      });

      render(<FileActionButtons status={status} />);

      const button = screen.getByRole('button', { name: /re-index/i });
      expect(button).toBeDisabled();
    });

    it('button is enabled when handler provided', () => {
      const status = createStatus({
        searchableChunksCount: 5,
        searchableInActive: true,
      });
      const onReindex = vi.fn();

      render(<FileActionButtons onReindex={onReindex} status={status} />);

      const button = screen.getByRole('button', { name: /re-index/i });
      expect(button).not.toBeDisabled();
    });

    it('calls handler when clicked', async () => {
      const user = userEvent.setup();
      const status = createStatus({
        fileId: 'test-file-id',
        searchableChunksCount: 5,
        searchableInActive: true,
      });
      const onReindex = vi.fn();

      render(<FileActionButtons onReindex={onReindex} status={status} />);

      const button = screen.getByRole('button', { name: /re-index/i });
      await user.click(button);

      expect(onReindex).toHaveBeenCalledWith('test-file-id');
      expect(onReindex).toHaveBeenCalledTimes(1);
    });

    it('shows "coming soon" tooltip when disabled', async () => {
      const user = userEvent.setup();
      const status = createStatus({
        searchableChunksCount: 5,
        searchableInActive: true,
      });

      render(<FileActionButtons status={status} />);

      const button = screen.getByRole('button', { name: /re-index/i });
      await user.hover(button);

      // Tooltip should explain feature is coming (Radix UI may duplicate for a11y)
      expect(await screen.findAllByText(/coming soon/i)).toHaveLength(2);
    });
  });

  describe('No buttons shown', () => {
    it('returns null for files with no chunks and not searchable', () => {
      const status = createStatus({
        searchableInActive: false,
        totalChunksCount: 0,
      });

      const { container } = render(<FileActionButtons status={status} />);

      expect(container.firstChild).toBeNull();
    });
  });
});
