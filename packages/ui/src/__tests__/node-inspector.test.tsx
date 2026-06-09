import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from '../collection-browser/node-inspector';
import type {
  ChunkData,
  CollectionData,
  EmbeddingData,
  FileData,
} from '../collection-browser/types';
import { TooltipProvider } from '../tooltip';

const renderWithProviders = (ui: React.ReactElement) =>
  render(ui, {
    wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
  });

describe('NodeInspector', () => {
  it('renders without crashing when no node is selected', () => {
    renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    // Component should render
    expect(document.body).toBeInTheDocument();
  });

  it('renders collapse toggle button', () => {
    renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    // Should have a button for collapse toggle
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('calls onCollapseChange when toggle is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        isCollapsed={false}
        nodeData={null}
        nodeType={null}
        onCollapseChange={onCollapseChange}
      />
    );

    const buttons = screen.getAllByRole('button');
    if (buttons.length > 0 && buttons[0]) {
      fireEvent.click(buttons[0]);
      expect(onCollapseChange).toHaveBeenCalled();
    }
  });

  it('applies custom className', () => {
    const { container } = renderWithProviders(
      <NodeInspector className="custom-class" nodeData={null} nodeType={null} />
    );

    const element = container.querySelector('.custom-class');
    expect(element).not.toBeNull();
  });

  it('renders with isCollapsed true', () => {
    renderWithProviders(<NodeInspector isCollapsed={true} nodeData={null} nodeType={null} />);

    // Should render without errors
    expect(document.body).toBeInTheDocument();
  });

  it('reflects expanded state via aria-expanded on the collapse toggle', () => {
    const { rerender } = renderWithProviders(
      <NodeInspector isCollapsed={false} nodeData={null} nodeType={null} />
    );
    expect(screen.getByRole('button', { name: 'Collapse inspector' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    rerender(<NodeInspector isCollapsed={true} nodeData={null} nodeType={null} />);
    expect(screen.getByRole('button', { name: 'Expand inspector' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('toggles collapse state when button is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        isCollapsed={true}
        nodeData={null}
        nodeType={null}
        onCollapseChange={onCollapseChange}
      />
    );

    const buttons = screen.getAllByRole('button');
    if (buttons.length > 0 && buttons[0]) {
      fireEvent.click(buttons[0]);
      expect(onCollapseChange).toHaveBeenCalledWith(false);
    }
  });

  it('accepts custom width as number', () => {
    const { container } = renderWithProviders(
      <NodeInspector nodeData={null} nodeType={null} width={400} />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('accepts custom width as string', () => {
    const { container } = renderWithProviders(
      <NodeInspector nodeData={null} nodeType={null} width="300px" />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('handles null nodeType and nodeData', () => {
    const { container } = renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    expect(container).toBeInTheDocument();
  });

  it('renders collection details, dates, and custom actions', () => {
    const collection: CollectionData = {
      chunkCount: 3456,
      createdAt: new Date('2026-06-09T12:00:00.000Z'),
      description: 'Product docs',
      dimensions: 1536,
      embeddingCount: 1234,
      fileCount: 12,
      modelId: 'text-embedding-3-small',
      name: 'Docs',
      updatedAt: new Date('2026-06-09T13:30:00.000Z'),
    };

    renderWithProviders(
      <NodeInspector
        actions={<button type="button">Reindex</button>}
        nodeData={collection}
        nodeId="collection-1"
        nodeType="collection"
      />
    );

    expect(screen.getByText('Collection Details')).toBeInTheDocument();
    expect(screen.getByText('collection-1')).toBeInTheDocument();
    expect(screen.getByText('Docs')).toBeInTheDocument();
    expect(screen.getByText('Product docs')).toBeInTheDocument();
    expect(screen.getByText('3,456')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
    expect(screen.getByText('1536d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reindex' })).toBeInTheDocument();
  });

  it('renders file details with size, mime type, progress, and import date', () => {
    const file: FileData = {
      chunkCount: 8,
      embeddingProgress: 45,
      embeddingStatus: 'processing',
      importedAt: new Date('2026-06-09T12:00:00.000Z'),
      mimeType: 'text/typescript',
      name: 'index.ts',
      path: 'src/index.ts',
      size: 1536,
    };

    renderWithProviders(<NodeInspector nodeData={file} nodeId="file-1" nodeType="file" />);

    expect(screen.getByText('File Details')).toBeInTheDocument();
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(screen.getByText('text/typescript')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('(45%)')).toBeInTheDocument();
  });

  it('renders chunk content and metadata', () => {
    const chunk: ChunkData = {
      content: 'export const answer = 42;',
      embeddingStatus: 'failed',
      index: 7,
      metadata: { language: 'ts', score: 0.82 },
      tokenCount: 2048,
    };

    renderWithProviders(<NodeInspector nodeData={chunk} nodeId="chunk-7" nodeType="chunk" />);

    expect(screen.getByText('Chunk Details')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('2,048')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('export const answer = 42;')).toBeInTheDocument();
    expect(screen.getByText(/"language": "ts"/)).toBeInTheDocument();
  });

  it('renders embedding similarity and metadata', () => {
    const embedding: EmbeddingData = {
      dimensions: 768,
      metadata: { source: 'semantic-search' },
      similarity: 0.9234,
      vectorId: 'vec-1',
    };

    renderWithProviders(
      <NodeInspector nodeData={embedding} nodeId="embedding-1" nodeType="embedding" />
    );

    expect(screen.getByText('Embedding Details')).toBeInTheDocument();
    expect(screen.getByText('vec-1')).toBeInTheDocument();
    expect(screen.getByText('768d')).toBeInTheDocument();
    expect(screen.getByText('92.34%')).toBeInTheDocument();
    expect(screen.getByText(/"source": "semantic-search"/)).toBeInTheDocument();
  });

  it('renders an empty content area for an unknown node type', () => {
    const file: FileData = {
      chunkCount: 0,
      embeddingStatus: 'none',
      name: 'unknown.txt',
      path: 'unknown.txt',
      size: 0,
    };

    renderWithProviders(<NodeInspector nodeData={file} nodeId="unknown-1" nodeType="mystery" />);

    expect(screen.getByText('Item Details')).toBeInTheDocument();
    expect(screen.getByText('unknown-1')).toBeInTheDocument();
    expect(screen.queryByText('unknown.txt')).not.toBeInTheDocument();
  });
});
