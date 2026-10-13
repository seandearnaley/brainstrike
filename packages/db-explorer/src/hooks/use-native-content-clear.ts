import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import type { ContentClearCapability, SourceFileRecord } from '@brainstrike/types';
import { useEffect, useState } from 'react';

export function useNativeContentClear(files: SourceFilesCapability, revision: number) {
  const capability = (
    globalThis as typeof globalThis & { electronAPI?: { content?: ContentClearCapability } }
  ).electronAPI?.content;
  const [snapshot, setSnapshot] = useState<{
    files: SourceFilesCapability;
    revision: number;
    result:
      | { records: readonly SourceFileRecord[]; error: null }
      | { records: null; error: string };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  useEffect(() => {
    let active = true;
    files.list().then(
      (records) => {
        if (active) {
          setSnapshot({ files, result: { error: null, records }, revision });
        }
      },
      (cause: unknown) => {
        if (active) {
          setSnapshot({
            files,
            result: {
              error: cause instanceof Error ? cause.message : String(cause),
              records: null,
            },
            revision,
          });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [files, revision]);
  const current =
    snapshot?.files === files && snapshot.revision === revision ? snapshot.result : null;
  const records = current?.records;
  const counts = records
    ? {
        chunks: records.some((file) => file.chunksCount === null)
          ? null
          : records.reduce((total, file) => total + (file.chunksCount ?? 0), 0),
        records: records.length,
      }
    : null;
  const clear = async () => {
    if (!capability) {
      setError('Content clearing is unavailable.');
      return;
    }
    setClearing(true);
    setError(null);
    try {
      await capability.clear('CONFIRM_CLEAR_DATABASE');
      // Main replaces the renderer after the same physical reset barrier.
      setShowClearDialog(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  };
  return {
    allowEmptyFiles: true,
    chunksCount: counts?.chunks ?? null,
    clearAllData: capability ? clear : null,
    clearing,
    countsPending: counts === null,
    error: error ?? current?.error ?? null,
    onClear: clear,
    recordsCount: counts?.records ?? 0,
    setShowClearDialog,
    showClearDialog,
  };
}
