import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionData,
  EmbeddingData,
  FileData,
  GroupHeaderData,
} from '../collection-browser/types';
import { useCollectionBrowserColumns } from '../collection-browser/use-collection-browser-columns';
import type { TreeNode, TreeTableCellProps } from '../tree-table/types';

const makeNode = <TData extends BrowserNodeData>(
  id: string,
  type: string,
  data: TData
): TreeNode<BrowserNodeData> => ({
  data,
  depth: 0,
  hasChildren: false,
  id,
  parentId: null,
  type,
});

const makeCellProps = (node: TreeNode<BrowserNodeData>): TreeTableCellProps<BrowserNodeData> => ({
  depth: node.depth,
  isExpanded: false,
  isHighlighted: false,
  isInContext: false,
  isSelected: false,
  node,
  rowIndex: 0,
});

const collectionNode = makeNode<CollectionData>('collection-main', 'collection', {
  chunkCount: 3,
  dimensions: 1536,
  embeddingCount: 4,
  fileCount: 2,
  modelId: 'text-embedding-3-small',
  name: 'Main Collection',
});

const fileNode = makeNode<FileData>('file-app', 'file', {
  chunkCount: 2,
  embeddingProgress: 50,
  embeddingStatus: 'processing',
  name: 'app.tsx',
  path: '/repo/app.tsx',
  size: 1536,
});

const chunkNode = makeNode<ChunkData>('chunk-app-0', 'chunk', {
  content: 'chunk text',
  embeddingStatus: 'complete',
  index: 0,
  tokenCount: 123,
});

const embeddingNode = makeNode<EmbeddingData>('embedding-app-0', 'embedding', {
  dimensions: 1536,
  vectorId: 'vector-1',
});

const groupNode = makeNode<GroupHeaderData>('group-status-complete', 'group', {
  groupKey: 'status',
  groupLabel: 'Complete',
  groupValue: 'complete',
  itemCount: 2,
});

describe('useCollectionBrowserColumns', () => {
  it('returns base columns and maps accessors for every supported node type', () => {
    const { result } = renderHook(() =>
      useCollectionBrowserColumns({
        semanticMatchIds: new Set(),
        showScoreColumn: false,
        similarityScores: new Map(),
      })
    );

    expect(result.current.map((column) => column.id)).toEqual(['name', 'status', 'size', 'meta']);

    const [nameColumn, statusColumn, sizeColumn] = result.current;
    if (!(nameColumn && statusColumn && sizeColumn)) {
      throw new Error('expected base columns');
    }

    expect(nameColumn.accessorFn?.(fileNode)).toBe('app.tsx');
    expect(statusColumn.accessorFn?.(fileNode)).toBe('processing');
    expect(statusColumn.accessorFn?.(chunkNode)).toBe('complete');
    expect(statusColumn.accessorFn?.(collectionNode)).toBe('');
    expect(sizeColumn.accessorFn?.(fileNode)).toBe(1536);
    expect(sizeColumn.accessorFn?.(chunkNode)).toBe(123);
    expect(sizeColumn.accessorFn?.(embeddingNode)).toBe(1536);
    expect(sizeColumn.accessorFn?.(collectionNode)).toBe(4);
  });

  it('inserts the score column after name when semantic scores are visible', () => {
    const { result } = renderHook(() =>
      useCollectionBrowserColumns({
        semanticMatchIds: new Set(['chunk-app-0']),
        showScoreColumn: true,
        similarityScores: new Map([['chunk-app-0', 0.876]]),
      })
    );

    expect(result.current.map((column) => column.id)).toEqual([
      'name',
      'score',
      'status',
      'size',
      'meta',
    ]);

    const scoreColumn = result.current.find((column) => column.id === 'score');
    if (!scoreColumn) {
      throw new Error('expected score column');
    }

    expect(scoreColumn.accessorFn?.(chunkNode)).toBe(0.876);
    expect(scoreColumn.accessorFn?.(fileNode)).toBe(0);

    render(scoreColumn.cell(makeCellProps(chunkNode)));
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByLabelText('Semantic match score')).toHaveAttribute('aria-valuenow', '88');
  });

  it('renders status, size, and metadata cells for contextual rows', () => {
    const { result } = renderHook(() =>
      useCollectionBrowserColumns({
        semanticMatchIds: new Set(),
        showScoreColumn: false,
        similarityScores: new Map(),
      })
    );

    const statusColumn = result.current.find((column) => column.id === 'status');
    const sizeColumn = result.current.find((column) => column.id === 'size');
    const metaColumn = result.current.find((column) => column.id === 'meta');
    if (!(statusColumn && sizeColumn && metaColumn)) {
      throw new Error('expected contextual columns');
    }

    render(
      <>
        {statusColumn.cell(makeCellProps(fileNode))}
        {statusColumn.cell(makeCellProps(chunkNode))}
        {statusColumn.cell(makeCellProps(collectionNode))}
        {sizeColumn.cell(makeCellProps(fileNode))}
        {sizeColumn.cell(makeCellProps(chunkNode))}
        {sizeColumn.cell(makeCellProps(embeddingNode))}
        {sizeColumn.cell(makeCellProps(collectionNode))}
        {metaColumn.cell(makeCellProps(collectionNode))}
        {metaColumn.cell(makeCellProps(fileNode))}
        {metaColumn.cell(makeCellProps(chunkNode))}
      </>
    );

    expect(screen.getByLabelText('Processing embedding status')).toBeInTheDocument();
    expect(screen.getByLabelText('Complete embedding status')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(screen.getByText('123 tokens')).toBeInTheDocument();
    expect(screen.getByText('1536d')).toBeInTheDocument();
    expect(screen.getByText('4 embeddings')).toBeInTheDocument();
    expect(screen.getByText(/text-embedding-3-small.*1536d/)).toBeInTheDocument();
    expect(screen.getByText('2 chunks (50%)')).toBeInTheDocument();
  });

  it('renders the name cell for every node kind and a muted score placeholder', () => {
    const { result } = renderHook(() =>
      useCollectionBrowserColumns({
        semanticMatchIds: new Set(),
        showScoreColumn: true,
        similarityScores: new Map(),
      })
    );

    const nameColumn = result.current.find((column) => column.id === 'name');
    const scoreColumn = result.current.find((column) => column.id === 'score');
    if (!(nameColumn && scoreColumn)) {
      throw new Error('expected name and score columns');
    }

    render(
      <>
        {nameColumn.cell(makeCellProps(collectionNode))}
        {nameColumn.cell(makeCellProps(fileNode))}
        {nameColumn.cell(makeCellProps(chunkNode))}
        {nameColumn.cell(makeCellProps(embeddingNode))}
        {nameColumn.cell(makeCellProps(groupNode))}
        {scoreColumn.cell(makeCellProps(fileNode))}
      </>
    );

    expect(screen.getByText('Main Collection')).toBeInTheDocument();
    expect(screen.getByText('app.tsx')).toBeInTheDocument();
    expect(screen.getByText('Chunk #0')).toBeInTheDocument();
    expect(screen.getByText('Vector')).toBeInTheDocument();
    expect(screen.getByText('\u2014')).toBeInTheDocument();
  });
});
