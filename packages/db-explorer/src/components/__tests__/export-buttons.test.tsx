import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExportButtonsProps } from '../../types';
import { ExportButtons } from '../export-buttons';

// Mock the UI module
vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button className={className} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

describe('ExportButtons', () => {
  const mockExportHandlers = {
    handleExportAll: vi.fn().mockResolvedValue(undefined),
    handleExportChunks: vi.fn(),
    handleExportEmbeddings: vi.fn(),
    handleExportFiles: vi.fn(),
  };

  const createProps = (overrides: Partial<ExportButtonsProps> = {}): ExportButtonsProps => ({
    counts: {
      chunks: 0,
      embeddings: 0,
      records: 0,
    },
    exportHandlers: mockExportHandlers,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all export buttons', () => {
    render(<ExportButtons {...createProps()} />);

    expect(screen.getByText(/Files \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/Chunks \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/Embeddings \(0\)/)).toBeInTheDocument();
    expect(screen.getByText(/All \(ZIP\)/)).toBeInTheDocument();
  });

  it('disables Files button when no records exist', () => {
    render(<ExportButtons {...createProps()} />);

    const filesButton = screen.getByText(/Files \(0\)/).closest('button');
    expect(filesButton).toBeDisabled();
  });

  it('enables Files button when records exist', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 0, embeddings: 0, records: 1 } })} />
    );

    const filesButton = screen.getByText(/Files \(1\)/).closest('button');
    expect(filesButton).not.toBeDisabled();
  });

  it('disables Chunks button when no chunks exist', () => {
    render(<ExportButtons {...createProps()} />);

    const chunksButton = screen.getByText(/Chunks \(0\)/).closest('button');
    expect(chunksButton).toBeDisabled();
  });

  it('enables Chunks button when chunks exist', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 1, embeddings: 0, records: 0 } })} />
    );

    const chunksButton = screen.getByText(/Chunks \(1\)/).closest('button');
    expect(chunksButton).not.toBeDisabled();
  });

  it('disables Embeddings button when no chunks with embeddings exist', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 1, embeddings: 0, records: 0 } })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(0\)/).closest('button');
    expect(embeddingsButton).toBeDisabled();
  });

  it('enables Embeddings button when chunks with embeddings exist', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 1, embeddings: 1, records: 0 } })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(1\)/).closest('button');
    expect(embeddingsButton).not.toBeDisabled();
  });

  it('disables All (ZIP) button when no records and chunks exist', () => {
    render(<ExportButtons {...createProps()} />);

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    expect(allButton).toBeDisabled();
  });

  it('enables All (ZIP) button when records exist', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 0, embeddings: 0, records: 1 } })} />
    );

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    expect(allButton).not.toBeDisabled();
  });

  it('calls handleExportFiles when Files button is clicked', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 0, embeddings: 0, records: 1 } })} />
    );

    const filesButton = screen.getByText(/Files \(1\)/).closest('button');
    fireEvent.click(filesButton!);

    expect(mockExportHandlers.handleExportFiles).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportChunks when Chunks button is clicked', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 1, embeddings: 0, records: 0 } })} />
    );

    const chunksButton = screen.getByText(/Chunks \(1\)/).closest('button');
    fireEvent.click(chunksButton!);

    expect(mockExportHandlers.handleExportChunks).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportEmbeddings when Embeddings button is clicked', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 1, embeddings: 1, records: 0 } })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(1\)/).closest('button');
    fireEvent.click(embeddingsButton!);

    expect(mockExportHandlers.handleExportEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportAll when All (ZIP) button is clicked', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 0, embeddings: 0, records: 1 } })} />
    );

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    fireEvent.click(allButton!);

    expect(mockExportHandlers.handleExportAll).toHaveBeenCalledTimes(1);
  });

  it('displays correct counts for records and chunks', () => {
    render(
      <ExportButtons {...createProps({ counts: { chunks: 3, embeddings: 2, records: 2 } })} />
    );

    expect(screen.getByText(/Files \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Chunks \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/Embeddings \(2\)/)).toBeInTheDocument();
  });
});
