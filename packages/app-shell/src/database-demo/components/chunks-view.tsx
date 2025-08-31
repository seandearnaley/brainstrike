import type { FileChunk, FileRecord } from '@brainstrike/db';
import { Badge } from '@brainstrike/ui';
import { Brain } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getActiveEmbeddingSetId } from '../../vector-preferences';
import { formatDate } from '../utils/format';

interface ChunksViewProps {
  chunks: FileChunk[];
  records: FileRecord[];
}

export function ChunksView({ chunks, records }: ChunksViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeSetId = useMemo(() => getActiveEmbeddingSetId(), []);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
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
              {chunk.embedding && chunk.embeddingSetId === activeSetId ? (
                <Badge variant="default" className="text-xs">
                  <Brain className="h-2 w-2 mr-1" />
                  <span>embedded</span>
                  <span aria-hidden="true" className="ml-1 opacity-70">
                    (selected set)
                  </span>
                </Badge>
              ) : chunk.embedding ? (
                <Badge variant="outline" className="text-xs">
                  <Brain className="h-2 w-2 mr-1" />
                  <span>embedded</span>
                  <span aria-hidden="true" className="ml-1 opacity-70">
                    (other set)
                  </span>
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs">
                  no embedding
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
          {chunk.embedding && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => toggle(chunk.id)}
                className="text-[11px] underline text-blue-600"
              >
                {expanded.has(chunk.id) ? 'Hide vector' : 'View vector'}
              </button>
              {expanded.has(chunk.id) && (
                <pre className="mt-2 max-h-32 overflow-auto text-[10px] bg-muted p-2 rounded">
                  {`[${chunk.embedding.slice(0, 32).join(', ')}${
                    chunk.embedding.length > 32 ? ', …' : ''
                  }] (${chunk.embedding.length} dims)`}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
