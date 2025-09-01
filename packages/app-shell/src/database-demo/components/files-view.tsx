import type { FileChunk, FileRecord } from '@brainstrike/db';
import { Badge, Button, ScrollArea } from '@brainstrike/ui';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { formatDate, formatFileSize } from '../utils/format';

interface FilesViewProps {
  records: FileRecord[];
  expandedFiles: Set<string>;
  onToggleFileExpansion: (fileId: string) => void;
  getFileChunks: (fileId: string) => FileChunk[];
}

export function FilesView({
  records,
  expandedFiles,
  onToggleFileExpansion,
  getFileChunks,
}: FilesViewProps) {
  if (records.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground">
        No files imported yet. Select files and click "Import Selected Files" to get started.
      </div>
    );
  }

  return (
    <ScrollArea className="h-[300px] w-full">
      <div className="space-y-2 pr-2">
        {records.map((record) => (
          <div key={record.id} className="border rounded p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onToggleFileExpansion(record.id)}
                  className="h-6 w-6 p-0"
                >
                  {expandedFiles.has(record.id) ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </Button>
                <span className="font-mono text-sm">{record.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {formatFileSize(record.size)}
                </Badge>
                {record.chunksCount && (
                  <Badge variant="outline" className="text-xs">
                    {record.chunksCount} chunks
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {record.processedAt ? formatDate(record.processedAt) : formatDate(record.createdAt)}
              </div>
            </div>

            {expandedFiles.has(record.id) && (
              <div className="mt-3 space-y-2">
                <div className="text-xs text-muted-foreground">Path: {record.path}</div>
                {record.chunkingStrategy && (
                  <div className="text-xs text-muted-foreground">
                    Chunking: {record.chunkingStrategy} • {record.chunksCount} chunks
                  </div>
                )}

                {/* Show chunks for this file */}
                {getFileChunks(record.id).length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs font-medium mb-1">Chunks:</div>
                    <ScrollArea className="h-40 w-full">
                      <div className="space-y-1 pr-2">
                        {getFileChunks(record.id).map((chunk) => (
                          <div key={chunk.id} className="p-2 bg-muted/50 rounded text-xs">
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
                            <div className="text-muted-foreground">
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
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
