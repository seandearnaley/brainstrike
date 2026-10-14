import { prepareFactoryReset } from '@brainstrike/app-state/factory-reset';
import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ContentClearCapability, SourceFileRecord } from '@brainstrike/types';
import { useEffect, useState } from 'react';

const logger = createLogger('NativeContentClear');

export function useNativeContentClear(
  files: SourceFilesCapability,
  revision: number,
  retireContentTabs: (() => void) | null
) {
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
    if (!(capability && retireContentTabs)) {
      setError('Content clearing is unavailable until conversation state can retire.');
      return;
    }
    setClearing(true);
    setError(null);
    try {
      // Clear replaces the renderer before its IPC reply. Join workspace writes and
      // retire persisted tab IDs first, while their existing host still owns them.
      await prepareFactoryReset();
      retireContentTabs();
      await capability.clear('CONFIRM_CLEAR_DATABASE');
      // Main replaces the renderer after the same physical reset barrier.
      setShowClearDialog(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      logger.error('Content clear failed after renderer preparation began', { error: cause });
      // Preparation is terminal, even on failure. Keep the action disabled and
      // reload through the existing lifecycle rather than reviving retired writers.
      try {
        await (
          window as typeof window & {
            desktopLifecycle?: { noteReloadIntent: (reason: string) => Promise<void> };
          }
        ).desktopLifecycle?.noteReloadIntent('content-clear-failed-after-preparation');
      } catch (error) {
        logger.error('Failed to record content clear reload intent', { error });
      }
      window.location.reload();
    }
  };
  return {
    allowEmptyFiles: true,
    chunksCount: counts?.chunks ?? null,
    clearAllData: capability && retireContentTabs ? clear : null,
    clearing,
    countsPending: counts === null,
    error: error ?? current?.error ?? null,
    onClear: clear,
    recordsCount: counts?.records ?? 0,
    setShowClearDialog,
    showClearDialog,
  };
}
