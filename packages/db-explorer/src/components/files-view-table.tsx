import type { FileChunk, FileRecord } from '@brainstrike/db';
import { Badge, Button, DataTable, type DataTableColumn, ScrollArea } from '@brainstrike/ui';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import type { FileCollectionStatus } from '../types/file-collection-status';
import { formatDate, formatFileSize } from '../utils/format';
import { FileActionButtons } from './file-action-buttons';
import { FileStatusBadge } from './file-status-badge';

interface FilesViewTableProps {
  records: FileRecord[];
  expandedFiles: Set<string>;
  onToggleFileExpansion: (fileId: string) => void;
  getFileChunks: (fileId: string) => FileChunk[];
  /** Active collection ID for filtering file status */
  activeCollectionId: string | null;
  /** Active collection name for display */
  activeCollectionName: string | null;
  /** Map of file IDs to their collection status */
  fileStatuses: Map<string, FileCollectionStatus>;
  /** Optional handler for making file searchable - if undefined, button is disabled */
  onMakeSearchable?: (fileId: string) => void;
  /** Optional handler for re-indexing file - if undefined, button is disabled */
  onReindex?: (fileId: string) => void;
}

export function FilesViewTable({
  records,
  expandedFiles,
  onToggleFileExpansion,
  getFileChunks,
  activeCollectionName,
  fileStatuses,
  onMakeSearchable,
  onReindex,
}: FilesViewTableProps) {
  const columns = useMemo<DataTableColumn<FileRecord>[]>(
    () => [
      {
        id: 'expand',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleFileExpansion(row.id)}
            className="h-6 w-6 p-0"
          >
            {expandedFiles.has(row.id) ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </Button>
        ),
        className: 'w-10',
      },
      {
        id: 'name',
        header: 'File Name',
        cell: ({ row }) => <span className="font-mono text-sm">{row.name}</span>,
        sortable: true,
        accessorFn: (row) => row.name,
      },
      {
        id: 'size',
        header: 'Size',
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-xs">
            {formatFileSize(row.size)}
          </Badge>
        ),
        sortable: true,
        accessorFn: (row) => row.size,
        className: 'w-24',
      },
      {
        id: 'chunks',
        header: 'Chunks',
        cell: ({ row }) =>
          row.chunksCount ? (
            <Badge variant="outline" className="text-xs">
              {row.chunksCount}
            </Badge>
          ) : null,
        sortable: true,
        accessorFn: (row) => row.chunksCount ?? 0,
        className: 'w-20',
      },
      {
        id: 'date',
        header: 'Processed',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.processedAt ? formatDate(row.processedAt) : formatDate(row.createdAt)}
          </span>
        ),
        sortable: true,
        accessorFn: (row) => row.processedAt ?? row.createdAt,
        className: 'w-40',
      },
      {
        id: 'status',
        header: 'Collection Status',
        cell: ({ row }) => {
          const status = fileStatuses.get(row.id);
          if (!status || !activeCollectionName) return null;
          return <FileStatusBadge status={status} activeCollectionName={activeCollectionName} />;
        },
        className: 'min-w-96',
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => {
          const status = fileStatuses.get(row.id);
          if (!status) return null;
          return (
            <FileActionButtons
              status={status}
              onMakeSearchable={onMakeSearchable}
              onReindex={onReindex}
            />
          );
        },
        className: 'w-48',
      },
    ],
    [
      expandedFiles,
      onToggleFileExpansion,
      fileStatuses,
      activeCollectionName,
      onMakeSearchable,
      onReindex,
    ]
  );

  const renderExpandedContent = (row: FileRecord) => {
    const chunks = getFileChunks(row.id);

    return (
      <div className="bg-muted/30 p-4 space-y-3">
        <div className="text-xs text-muted-foreground">
          <div>Path: {row.path}</div>
          {row.chunkingStrategy && (
            <div className="mt-1">
              Chunking: {row.chunkingStrategy} • {row.chunksCount} chunks
            </div>
          )}
        </div>

        {chunks.length > 0 && (
          <div>
            <div className="text-xs font-medium mb-2">Chunks:</div>
            <ScrollArea className="h-40 w-full">
              <div className="space-y-2 pr-2">
                {chunks.map((chunk) => (
                  <div key={chunk.id} className="p-2 bg-background rounded text-xs border">
                    <div className="flex justify-between items-start mb-1">
                      <Badge variant="outline" className="text-xs">
                        {chunk.chunkType} #{chunk.chunkIndex}
                      </Badge>
                      <div className="flex gap-1">
                        <Badge variant="secondary" className="text-xs">
                          {chunk.tokenCount} tokens
                        </Badge>
                        {chunk.embedding && (
                          <Badge variant="default" className="text-xs">
                            <Brain className="h-2 w-2 mr-1" />
                            embedded
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-muted-foreground mt-1">
                      {chunk.content.substring(0, 200)}
                      {chunk.content.length > 200 && '...'}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    );
  };

  return (
    <DataTable
      columns={columns}
      data={records}
      getRowId={(row) => row.id}
      maxHeight="400px"
      expandable={{
        enabled: true,
        expandedRows: expandedFiles,
        onToggleExpand: onToggleFileExpansion,
        renderExpandedContent,
      }}
      emptyState={
        <div className="text-center">
          No files imported yet. Select files and click "Import Selected Files" to get started.
        </div>
      }
    />
  );
}
