import type { SourceChunkPage, SourceFilesCapability } from '@brainstrike/assistant-contract';
import type { SourceFileRecord } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { useEffect, useRef, useState } from 'react';

type Capability = Pick<SourceFilesCapability, 'list' | 'read' | 'chunks' | 'delete'>;
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export function NativeLibraryFiles({
  files,
  collectionId,
  revision,
}: {
  files: Capability;
  collectionId: string | null;
  revision: number;
}) {
  const [listing, setListing] = useState<{
    records: readonly SourceFileRecord[];
    error: string | null;
    files: Capability;
    collectionId: string | null;
    revision: number;
    refresh: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<{
    id: string;
    content: string | null;
    chunks: SourceChunkPage | null;
    reason: string | null;
  } | null>(null);
  const listingCurrent =
    listing?.files === files &&
    listing.collectionId === collectionId &&
    listing.revision === revision &&
    listing.refresh === refresh;
  const records = listingCurrent ? listing.records : [];
  const listingError = listingCurrent ? listing.error : null;
  const request = useRef(0);
  useEffect(() => {
    let current = true;
    request.current += 1;
    files.list().then(
      (rows) => {
        if (current) {
          setListing({
            collectionId,
            error: null,
            files,
            records: rows.filter((file) => file.embeddingSetId === collectionId),
            refresh,
            revision,
          });
        }
      },
      (cause) => {
        if (current) {
          setListing({
            collectionId,
            error: errorText(cause),
            files,
            records: [],
            refresh,
            revision,
          });
        }
      }
    );
    return () => {
      current = false;
      request.current += 1;
    };
  }, [files, collectionId, revision, refresh]);
  const preview = async (file: SourceFileRecord) => {
    const version = ++request.current;
    setError(null);
    setSelection(null);
    try {
      const retained = (await files.read([file.fileId], file.stat.size))[0];
      if (!retained || retained.fileId !== file.fileId || retained.content === null) {
        throw new Error('The retained source bytes are unavailable. Refresh this file.');
      }
      if (version !== request.current) {
        return;
      }
      setSelection({ chunks: null, content: retained.content, id: file.fileId, reason: null });
      const page = await files.chunks({ fileId: file.fileId, limit: 100, offset: 0 });
      if (version === request.current) {
        setSelection({
          chunks: page.kind === 'available' ? page : null,
          content: retained.content,
          id: file.fileId,
          reason: page.kind === 'unavailable' ? page.reason : null,
        });
      }
    } catch (cause) {
      if (version === request.current) {
        setError(errorText(cause));
      }
    }
  };
  const next = async () => {
    const previous = selection;
    const page = previous?.chunks;
    if (!page || page.nextOffset === null) {
      return;
    }
    const version = ++request.current;
    try {
      const result = await files.chunks({
        expected: {
          contentHash: page.contentHash,
          profileHash: page.profileHash,
          snapshotHash: page.snapshotHash,
        },
        fileId: page.fileId,
        limit: 100,
        offset: page.nextOffset,
      });
      if (version !== request.current) {
        return;
      }
      if (result.kind === 'unavailable') {
        throw new Error(result.reason);
      }
      setSelection({ ...previous, chunks: result });
    } catch (cause) {
      if (version === request.current) {
        setError(errorText(cause));
      }
    }
  };
  const remove = async (file: SourceFileRecord) => {
    setPending(true);
    setError(null);
    try {
      await files.delete([file.fileId]);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      aria-busy={pending || !listingCurrent}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
      data-testid="native-library-files"
    >
      {error || listingError ? <p role="alert">{error ?? listingError}</p> : null}
      <ul aria-label="Library files" className="space-y-1">
        {records.map((file) => (
          <li className="flex items-center justify-between gap-2" key={file.fileId}>
            <Button
              onClick={() => {
                void preview(file);
              }}
              variant="ghost"
            >
              {file.fileName}
            </Button>
            <span className="text-muted-foreground text-xs">
              {file.stat.size} bytes ·{' '}
              {file.chunksCount === null ? 'Chunks unavailable' : `${file.chunksCount} chunks`}
            </span>
            <Button
              aria-label={`Delete ${file.fileName}`}
              disabled={pending}
              onClick={() => {
                void remove(file);
              }}
              size="sm"
              variant="ghost"
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      {!(pending || !listingCurrent) && records.length === 0 && !error ? (
        <p>
          No files in this collection. Select files in Explorer and choose Import into collection.
        </p>
      ) : null}
      {selection ? (
        <section aria-label="File preview">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{selection.content}</pre>
          {selection.reason ? <p role="status">{selection.reason}</p> : null}
          {selection.chunks ? (
            <>
              <h3>Chunks · {selection.chunks.total}</h3>
              {selection.chunks.chunks.map((chunk) => (
                <details key={chunk.chunkId}>
                  <summary>
                    Lines {chunk.startLine}–{chunk.endLine} ·{' '}
                    {chunk.vector ? `${chunk.vector.dimensions} dimensions` : 'Vector unavailable'}
                  </summary>
                  <pre className="overflow-auto whitespace-pre-wrap">{chunk.content}</pre>
                  {chunk.vector ? (
                    <pre className="overflow-auto">{JSON.stringify(chunk.vector.values)}</pre>
                  ) : null}
                </details>
              ))}
              {selection.chunks.nextOffset === null ? null : (
                <Button
                  onClick={() => {
                    void next();
                  }}
                >
                  Next chunks
                </Button>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
