import { render } from '@testing-library/react';
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionBrowser } from '../collection-browser/collection-browser';
import type { BrowserNodeData, SemanticSearchResult } from '../collection-browser/types';
import type { CollectionTreeInput } from '../collection-browser/use-collection-tree';
import type { TreeTableProps } from '../tree-table/types';

const treeTableSpy = vi.fn<(props: TreeTableProps<BrowserNodeData>) => void>();

vi.mock('../tree-table/tree-table', () => ({
  DEFAULT_AUTO_PAGED_ROW_THRESHOLD: 200,
  TreeTable: (props: TreeTableProps<BrowserNodeData>) => {
    treeTableSpy(props);
    return <div data-testid="tree-table-mock">{props.emptyState as React.ReactNode}</div>;
  },
}));

const TEST_DATA: CollectionTreeInput = {
  chunks: [
    {
      chunkIndex: 0,
      content: 'alpha',
      embedding: [0.1, 0.2],
      fileRecordId: 'file-a',
      id: 'chunk-a',
      tokenCount: 8,
    },
    {
      chunkIndex: 0,
      content: 'beta',
      embedding: [0.1, 0.2],
      fileRecordId: 'file-b',
      id: 'chunk-b',
      tokenCount: 8,
    },
  ],
  files: [
    {
      chunksCount: 1,
      id: 'file-a',
      name: 'a.ts',
      path: '/a.ts',
      size: 120,
    },
    {
      chunksCount: 1,
      id: 'file-b',
      name: 'b.ts',
      path: '/b.ts',
      size: 160,
    },
  ],
};

const SEMANTIC_RESULTS: SemanticSearchResult[] = [
  {
    chunkId: 'chunk-a',
    content: 'alpha',
    fileName: 'a.ts',
    filePath: '/a.ts',
    fileRecordId: 'file-a',
    nodeId: 'chunk-chunk-a',
    similarity: 0.93,
  },
];

function getLatestTreeTableProps(): TreeTableProps<BrowserNodeData> {
  const latestCall = treeTableSpy.mock.calls.at(-1);
  const latestProps = latestCall?.[0];
  expect(latestProps).toBeDefined();
  return latestProps as TreeTableProps<BrowserNodeData>;
}

describe('CollectionBrowser windowing configuration', () => {
  beforeEach(() => {
    treeTableSpy.mockClear();
  });

  it('uses auto strategy with browse context by default', () => {
    render(<CollectionBrowser data={TEST_DATA} />);

    const treeTableProps = getLatestTreeTableProps();
    expect(treeTableProps.windowingStrategy).toBe('auto');
    expect(treeTableProps.autoWindowingContext).toBe('browse');
    expect(treeTableProps.pagination).toBeUndefined();
  });

  it('uses search context and semantic pagination defaults when semantic results are active', () => {
    render(
      <CollectionBrowser
        data={TEST_DATA}
        hasSearched={true}
        searchMode="semantic"
        semanticResults={SEMANTIC_RESULTS}
      />
    );

    const treeTableProps = getLatestTreeTableProps();
    expect(treeTableProps.windowingStrategy).toBe('auto');
    expect(treeTableProps.autoWindowingContext).toBe('search');
    expect(treeTableProps.pagination).toMatchObject({
      pageInfo: 'semantic results',
      pageSizeOptions: [25, 50, 100, 250],
      showControls: true,
      showItemRange: true,
    });
  });

  it('keeps browse context defaults for quick search results', () => {
    render(
      <CollectionBrowser
        data={TEST_DATA}
        hasSearched={true}
        searchMode="quick"
        semanticResults={SEMANTIC_RESULTS}
      />
    );

    const treeTableProps = getLatestTreeTableProps();
    expect(treeTableProps.windowingStrategy).toBe('auto');
    expect(treeTableProps.autoWindowingContext).toBe('browse');
    expect(treeTableProps.pagination).toBeUndefined();
  });

  it('honors explicit tree windowing overrides', () => {
    render(
      <CollectionBrowser
        data={TEST_DATA}
        treeAutoPagedRowThreshold={12}
        treePagination={{ pageSize: 20, showControls: false }}
        treeWindowingStrategy="paged"
      />
    );

    const treeTableProps = getLatestTreeTableProps();
    expect(treeTableProps.windowingStrategy).toBe('paged');
    expect(treeTableProps.autoPagedRowThreshold).toBe(12);
    expect(treeTableProps.pagination).toMatchObject({
      pageSize: 20,
      showControls: false,
    });
  });
});
