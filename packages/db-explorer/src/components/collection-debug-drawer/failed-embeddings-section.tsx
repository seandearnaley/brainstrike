/**
 * Flat list of files that are not fully embedded, replacing the retired
 * browser's "browse everything, then filter by status" flow.
 *
 * Headline totals come from the existing `useCollectionEmbeddingCoverage`
 * query; the per-file breakdown is a one-shot bounded read refreshed only on
 * demand.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import { Button, EMBEDDING_STATUS_CONFIG } from '@brainstrike/ui';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCollectionEmbeddingCoverage } from '../../hooks/use-collection-embedding-coverage';
import {
  DRAWER_INCOMPLETE_FILE_LIMIT,
  type DrawerIncompleteFile,
  loadIncompleteFiles,
} from './collection-debug-queries';
import { deriveFileEmbeddingStatus } from './drawer-model';
import { DrawerSection, StatusDot } from './drawer-primitives';
import { fileRowToTarget } from './drawer-targets';
import { openRowContextMenu } from './open-row-context-menu';

type ClaimTarget = (target: ContextTarget, element: HTMLElement) => void;

interface FailedEmbeddingsSectionProps {
  readonly activeCollectionId: string | null;
  readonly database: unknown;
  readonly onClaimTarget: ClaimTarget;
}

export function FailedEmbeddingsSection({
  activeCollectionId,
  database,
  onClaimTarget,
}: FailedEmbeddingsSectionProps) {
  const { snapshot } = useCollectionEmbeddingCoverage(activeCollectionId);
  const [files, setFiles] = useState<readonly DrawerIncompleteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Generation counter for in-flight reads. A ref rather than state so an
   * explicit refresh reuses exactly the same load path as the initial one
   * without a token in the dependency array.
   */
  const requestRef = useRef(0);

  const loadFiles = useCallback(() => {
    if (!activeCollectionId) {
      setFiles([]);
      setError(null);
      return;
    }
    requestRef.current += 1;
    const requestId = requestRef.current;
    const isCurrent = () => requestRef.current === requestId;
    setLoading(true);
    setError(null);
    loadIncompleteFiles(database, activeCollectionId)
      .then((rows) => {
        if (isCurrent()) {
          setFiles(rows);
        }
      })
      .catch((cause: unknown) => {
        if (isCurrent()) {
          setFiles([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (isCurrent()) {
          setLoading(false);
        }
      });
  }, [activeCollectionId, database]);

  useEffect(() => {
    loadFiles();
    // Invalidate any in-flight read when the collection changes or the section
    // unmounts, so a late response cannot write into a stale section.
    return () => {
      requestRef.current += 1;
    };
  }, [loadFiles]);

  const truncated = files.length >= DRAWER_INCOMPLETE_FILE_LIMIT;

  return (
    <DrawerSection
      subtitle={`${snapshot.totalFiles} file(s), ${snapshot.totalChunks} chunk(s) indexed`}
      testId="collection-debug-failed"
      title="Not fully embedded"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {loading ? 'Loading…' : `${files.length} file(s) need attention`}
        </span>
        <Button
          aria-label="Refresh the not-fully-embedded list"
          className="size-6 p-0"
          disabled={loading || !activeCollectionId}
          onClick={loadFiles}
          size="sm"
          variant="ghost"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {error ? (
        <div
          className="flex items-start gap-1.5 text-destructive text-xs"
          data-testid="collection-debug-failed-error"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      ) : null}

      {!(loading || error) && files.length === 0 ? (
        <div className="px-2 py-1 text-muted-foreground text-xs">
          {activeCollectionId
            ? 'Every file in this collection is fully embedded.'
            : 'Select a collection to list files that need attention.'}
        </div>
      ) : null}

      <ul className="max-h-40 overflow-y-auto" data-testid="collection-debug-failed-list">
        {files.map((file) => {
          const status = deriveFileEmbeddingStatus(file);
          return (
            <li key={file.id}>
              {/* This row's only affordance is its context menu, so Enter and
                  click both open it (see openRowContextMenu) — the button role
                  never promises an action it cannot perform. */}
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={(event) => openRowContextMenu(event.currentTarget)}
                onContextMenu={(event) =>
                  onClaimTarget(
                    fileRowToTarget({ id: file.id, name: file.name, path: file.path }),
                    event.currentTarget
                  )
                }
                type="button"
              >
                <StatusDot decorative status={status} />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {EMBEDDING_STATUS_CONFIG[status].label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {file.embeddedChunksCount}/{file.chunksCount}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {truncated ? (
        <div className="px-2 pt-1 text-[10px] text-muted-foreground" role="note">
          Showing the first {DRAWER_INCOMPLETE_FILE_LIMIT} files — more may need attention.
        </div>
      ) : null}
    </DrawerSection>
  );
}
