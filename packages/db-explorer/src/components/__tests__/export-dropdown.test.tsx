import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportButtonsProps } from '../../types';
import { ExportDropdown } from '../export-dropdown';

// Mock the UI module with minimal dropdown components
vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button className={className} disabled={disabled} onClick={onClick} type="button" {...rest}>
      {children}
    </button>
  ),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
}));

describe('ExportDropdown', () => {
  const mockExportHandlers = {
    handleExportFiles: vi.fn(),
    handleExportChunks: vi.fn(),
    handleExportEmbeddings: vi.fn(),
    handleExportAll: vi.fn().mockResolvedValue(undefined),
  };

  const createProps = (overrides: Partial<ExportButtonsProps> = {}): ExportButtonsProps => ({
    counts: {
      records: 0,
      chunks: 0,
      embeddings: 0,
    },
    exportHandlers: mockExportHandlers,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Export trigger button', () => {
    render(<ExportDropdown {...createProps()} />);
    expect(screen.getByText('Export')).toBeInTheDocument();
  });

  it('renders the Export Data label', () => {
    render(<ExportDropdown {...createProps()} />);
    expect(screen.getByText('Export Data')).toBeInTheDocument();
  });

  it('renders menu items for Files, Chunks, Embeddings, and All', () => {
    render(<ExportDropdown {...createProps()} />);
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Chunks')).toBeInTheDocument();
    expect(screen.getByText('Embeddings')).toBeInTheDocument();
    expect(screen.getByText('All (ZIP)')).toBeInTheDocument();
  });

  it('displays counts for each export type', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 5, chunks: 42, embeddings: 10 } })} />
    );
    expect(screen.getByText('Files').closest('button')).toHaveTextContent('5');
    expect(screen.getByText('Chunks').closest('button')).toHaveTextContent('42');
    expect(screen.getByText('Embeddings').closest('button')).toHaveTextContent('10');
  });

  it('disables Files menu item when no files exist', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 0, chunks: 5, embeddings: 0 } })} />
    );
    const filesButton = screen.getByText('Files').closest('button');
    expect(filesButton).toBeDisabled();
  });

  it('disables Chunks menu item when no chunks exist', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 5, chunks: 0, embeddings: 0 } })} />
    );
    const chunksButton = screen.getByText('Chunks').closest('button');
    expect(chunksButton).toBeDisabled();
  });

  it('disables Embeddings menu item when no embeddings exist', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 5, chunks: 5, embeddings: 0 } })} />
    );
    const embeddingsButton = screen.getByText('Embeddings').closest('button');
    expect(embeddingsButton).toBeDisabled();
  });

  it('enables menu items when data exists', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 3, chunks: 10, embeddings: 5 } })} />
    );
    const filesButton = screen.getByText('Files').closest('button');
    const chunksButton = screen.getByText('Chunks').closest('button');
    const embeddingsButton = screen.getByText('Embeddings').closest('button');
    expect(filesButton).not.toBeDisabled();
    expect(chunksButton).not.toBeDisabled();
    expect(embeddingsButton).not.toBeDisabled();
  });

  it('calls handleExportFiles when Files is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExportDropdown {...createProps({ counts: { records: 3, chunks: 0, embeddings: 0 } })} />
    );
    await user.click(screen.getByText('Files'));
    expect(mockExportHandlers.handleExportFiles).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportChunks when Chunks is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExportDropdown {...createProps({ counts: { records: 0, chunks: 10, embeddings: 0 } })} />
    );
    await user.click(screen.getByText('Chunks'));
    expect(mockExportHandlers.handleExportChunks).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportEmbeddings when Embeddings is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExportDropdown {...createProps({ counts: { records: 0, chunks: 0, embeddings: 5 } })} />
    );
    await user.click(screen.getByText('Embeddings'));
    expect(mockExportHandlers.handleExportEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportAll when All (ZIP) is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ExportDropdown {...createProps({ counts: { records: 5, chunks: 10, embeddings: 3 } })} />
    );
    await user.click(screen.getByText('All (ZIP)'));
    expect(mockExportHandlers.handleExportAll).toHaveBeenCalledTimes(1);
  });

  it('disables the trigger button when no data exists', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 0, chunks: 0, embeddings: 0 } })} />
    );
    const trigger = screen.getByText('Export').closest('button');
    expect(trigger).toBeDisabled();
  });

  it('enables the trigger button when files exist', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 1, chunks: 0, embeddings: 0 } })} />
    );
    const trigger = screen.getByText('Export').closest('button');
    expect(trigger).not.toBeDisabled();
  });

  it('enables the trigger button when chunks exist', () => {
    render(
      <ExportDropdown {...createProps({ counts: { records: 0, chunks: 1, embeddings: 0 } })} />
    );
    const trigger = screen.getByText('Export').closest('button');
    expect(trigger).not.toBeDisabled();
  });
});
