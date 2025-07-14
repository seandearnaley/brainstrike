import type { FileChunk, FileRecord } from '@brainstrike/db';
import { Badge } from '@brainstrike/ui';
import { Brain } from 'lucide-react';
import { formatDate } from '../utils/format';

interface ChunksViewProps {
  chunks: FileChunk[];
  records: FileRecord[];
}

export function ChunksView({ chunks, records }: ChunksViewProps) {
  if (chunks.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground">
        No chunks available. Enable chunking in import settings and import some files.
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-full overflow-y-auto">
      {chunks.map((chunk) => (
        <div key={chunk.id} className="border rounded p-3">
          <div className="flex justify-between items-start mb-2">
            <div className="flex gap-2">
              <Badge variant="outline" className="text-xs">
                {chunk.chunkType} #{chunk.chunkIndex}
              </Badge>
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
            <div className="text-xs text-muted-foreground">{formatDate(chunk.createdAt)}</div>
          </div>
          <div className="text-sm text-muted-foreground mb-2">
            {chunk.content.substring(0, 300)}
            {chunk.content.length > 300 && '...'}
          </div>
          <div className="text-xs text-muted-foreground">
            File: {records.find((r) => r.id === chunk.fileRecordId)?.name || 'Unknown'}
          </div>
        </div>
      ))}
    </div>
  );
}
