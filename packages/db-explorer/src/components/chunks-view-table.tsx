import type { FileChunk, FileRecord } from '@brainstrike/db';
import { Badge, DataTable, type DataTableColumn, ScrollArea } from '@brainstrike/ui';
import { Brain } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatDate } from '../utils/format';

interface ChunksViewTableProps {
  chunks: FileChunk[];
  records: FileRecord[];
  pendingChunkIds?: Set<string>;
  activeCollectionId: string | null;
}

function getEmbeddingBadge(chunk: FileChunk, activeSetId: string | null, isPending: boolean) {
  if (isPending) {
    return (
      <Badge variant="secondary" className="text-xs">
        <Brain className="h-2 w-2 mr-1" />
        <span>pending</span>
      </Badge>
    );
  }

  if (!chunk.embedding) {
    return (
      <Badge variant="outline" className="text-xs">
        no embedding
      </Badge>
    );
  }

  const isActiveSet = chunk.embeddingSetId === activeSetId;
  return (
    <Badge variant={isActiveSet ? 'default' : 'outline'} className="text-xs">
      <Brain className="h-2 w-2 mr-1" />
      <span>embedded</span>
      {isActiveSet && <span className="ml-1 opacity-70">(active)</span>}
    </Badge>
  );
}

export function ChunksViewTable({
  chunks,
  records,
  pendingChunkIds,
  activeCollectionId,
}: ChunksViewTableProps) {
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());

  const toggleExpanded = (chunkId: string) => {
    setExpandedChunks((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  };

  const columns = useMemo<DataTableColumn<FileChunk>[]>(
    () => [
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {row.chunkType} #{row.chunkIndex}
          </Badge>
        ),
        sortable: true,
        accessorFn: (row) => `${row.chunkType}-${row.chunkIndex}`,
        className: 'w-32',
      },
      {
        id: 'tokens',
        header: 'Tokens',
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-xs">
            {row.tokenCount}
          </Badge>
        ),
        sortable: true,
        accessorFn: (row) => row.tokenCount,
        className: 'w-20',
      },
      {
        id: 'embedding',
        header: 'Embedding',
        cell: ({ row }) =>
          getEmbeddingBadge(row, activeCollectionId, pendingChunkIds?.has(row.id) ?? false),
        className: 'w-36',
      },
      {
        id: 'content',
        header: 'Content',
        cell: ({ row }) => (
          <div className="text-sm">
            {row.content.substring(0, 150)}
            {row.content.length > 150 && '...'}
          </div>
        ),
      },
      {
        id: 'file',
        header: 'File',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {records.find((r) => r.id === row.fileRecordId)?.name || 'Unknown'}
          </span>
        ),
        className: 'w-48',
      },
      {
        id: 'date',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
        ),
        sortable: true,
        accessorFn: (row) => row.createdAt,
        className: 'w-32',
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          row.embedding ? (
            <button
              type="button"
              onClick={() => toggleExpanded(row.id)}
              className="text-xs underline text-blue-600 hover:text-blue-800"
            >
              {expandedChunks.has(row.id) ? 'Hide vector' : 'View vector'}
            </button>
          ) : null,
        className: 'w-24',
      },
    ],
    [activeCollectionId, pendingChunkIds, records, expandedChunks]
  );

  const renderExpandedContent = (row: FileChunk) => {
    if (!row.embedding || !expandedChunks.has(row.id)) return null;

    return (
      <div className="bg-muted/30 p-4">
        <div className="text-xs font-medium mb-2">Embedding Vector:</div>
        <ScrollArea className="h-32 w-full">
          <pre className="text-[10px] bg-background p-3 rounded border font-mono">
            {`[${row.embedding.slice(0, 32).join(', ')}${
              row.embedding.length > 32 ? ', …' : ''
            }] (${row.embedding.length} dimensions)`}
          </pre>
        </ScrollArea>
      </div>
    );
  };

  return (
    <DataTable
      columns={columns}
      data={chunks}
      getRowId={(row) => row.id}
      maxHeight="400px"
      expandable={{
        enabled: true,
        expandedRows: expandedChunks,
        onToggleExpand: toggleExpanded,
        renderExpandedContent,
      }}
      pagination={{
        enabled: true,
        pageSize: 50,
      }}
      emptyState={
        <div className="text-center">
          No chunks available. Enable chunking in import settings and import some files.
        </div>
      }
    />
  );
}
