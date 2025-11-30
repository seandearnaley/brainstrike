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
    handleExportFiles: vi.fn(),
    handleExportChunks: vi.fn(),
    handleExportEmbeddings: vi.fn(),
    handleExportAll: vi.fn().mockResolvedValue(undefined),
  };

  const createProps = (overrides: Partial<ExportButtonsProps> = {}): ExportButtonsProps => ({
    records: [],
    chunks: [],
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
    render(<ExportButtons {...createProps({ records: [] })} />);

    const filesButton = screen.getByText(/Files \(0\)/).closest('button');
    expect(filesButton).toBeDisabled();
  });

  it('enables Files button when records exist', () => {
    const mockRecords = [
      {
        id: '1',
        name: 'file1.txt',
        path: '/path/file1.txt',
        size: 100,
        createdAt: '',
        updatedAt: '',
      },
    ];
    render(
      <ExportButtons {...createProps({ records: mockRecords as ExportButtonsProps['records'] })} />
    );

    const filesButton = screen.getByText(/Files \(1\)/).closest('button');
    expect(filesButton).not.toBeDisabled();
  });

  it('disables Chunks button when no chunks exist', () => {
    render(<ExportButtons {...createProps({ chunks: [] })} />);

    const chunksButton = screen.getByText(/Chunks \(0\)/).closest('button');
    expect(chunksButton).toBeDisabled();
  });

  it('enables Chunks button when chunks exist', () => {
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
      },
    ];
    render(
      <ExportButtons {...createProps({ chunks: mockChunks as ExportButtonsProps['chunks'] })} />
    );

    const chunksButton = screen.getByText(/Chunks \(1\)/).closest('button');
    expect(chunksButton).not.toBeDisabled();
  });

  it('disables Embeddings button when no chunks with embeddings exist', () => {
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
      },
    ];
    render(
      <ExportButtons {...createProps({ chunks: mockChunks as ExportButtonsProps['chunks'] })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(0\)/).closest('button');
    expect(embeddingsButton).toBeDisabled();
  });

  it('enables Embeddings button when chunks with embeddings exist', () => {
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
        embedding: [0.1, 0.2],
      },
    ];
    render(
      <ExportButtons {...createProps({ chunks: mockChunks as ExportButtonsProps['chunks'] })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(1\)/).closest('button');
    expect(embeddingsButton).not.toBeDisabled();
  });

  it('disables All (ZIP) button when no records and chunks exist', () => {
    render(<ExportButtons {...createProps({ records: [], chunks: [] })} />);

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    expect(allButton).toBeDisabled();
  });

  it('enables All (ZIP) button when records exist', () => {
    const mockRecords = [
      {
        id: '1',
        name: 'file1.txt',
        path: '/path/file1.txt',
        size: 100,
        createdAt: '',
        updatedAt: '',
      },
    ];
    render(
      <ExportButtons {...createProps({ records: mockRecords as ExportButtonsProps['records'] })} />
    );

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    expect(allButton).not.toBeDisabled();
  });

  it('calls handleExportFiles when Files button is clicked', () => {
    const mockRecords = [
      {
        id: '1',
        name: 'file1.txt',
        path: '/path/file1.txt',
        size: 100,
        createdAt: '',
        updatedAt: '',
      },
    ];
    render(
      <ExportButtons {...createProps({ records: mockRecords as ExportButtonsProps['records'] })} />
    );

    const filesButton = screen.getByText(/Files \(1\)/).closest('button');
    fireEvent.click(filesButton!);

    expect(mockExportHandlers.handleExportFiles).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportChunks when Chunks button is clicked', () => {
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
      },
    ];
    render(
      <ExportButtons {...createProps({ chunks: mockChunks as ExportButtonsProps['chunks'] })} />
    );

    const chunksButton = screen.getByText(/Chunks \(1\)/).closest('button');
    fireEvent.click(chunksButton!);

    expect(mockExportHandlers.handleExportChunks).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportEmbeddings when Embeddings button is clicked', () => {
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
        embedding: [0.1, 0.2],
      },
    ];
    render(
      <ExportButtons {...createProps({ chunks: mockChunks as ExportButtonsProps['chunks'] })} />
    );

    const embeddingsButton = screen.getByText(/Embeddings \(1\)/).closest('button');
    fireEvent.click(embeddingsButton!);

    expect(mockExportHandlers.handleExportEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('calls handleExportAll when All (ZIP) button is clicked', () => {
    const mockRecords = [
      {
        id: '1',
        name: 'file1.txt',
        path: '/path/file1.txt',
        size: 100,
        createdAt: '',
        updatedAt: '',
      },
    ];
    render(
      <ExportButtons {...createProps({ records: mockRecords as ExportButtonsProps['records'] })} />
    );

    const allButton = screen.getByText(/All \(ZIP\)/).closest('button');
    fireEvent.click(allButton!);

    expect(mockExportHandlers.handleExportAll).toHaveBeenCalledTimes(1);
  });

  it('displays correct counts for records and chunks', () => {
    const mockRecords = [
      {
        id: '1',
        name: 'file1.txt',
        path: '/path/file1.txt',
        size: 100,
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '2',
        name: 'file2.txt',
        path: '/path/file2.txt',
        size: 200,
        createdAt: '',
        updatedAt: '',
      },
    ];
    const mockChunks = [
      {
        id: '1',
        fileRecordId: '1',
        chunkIndex: 0,
        content: 'test',
        contentHash: 'hash',
        tokenCount: 10,
        embedding: [0.1],
      },
      {
        id: '2',
        fileRecordId: '1',
        chunkIndex: 1,
        content: 'test2',
        contentHash: 'hash2',
        tokenCount: 15,
        embedding: [0.2],
      },
      {
        id: '3',
        fileRecordId: '2',
        chunkIndex: 0,
        content: 'test3',
        contentHash: 'hash3',
        tokenCount: 20,
      },
    ];

    render(
      <ExportButtons
        {...createProps({
          records: mockRecords as ExportButtonsProps['records'],
          chunks: mockChunks as ExportButtonsProps['chunks'],
        })}
      />
    );

    expect(screen.getByText(/Files \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Chunks \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/Embeddings \(2\)/)).toBeInTheDocument();
  });
});
