import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { LogRecord } from '@brainstrike/logging';
import type { useToast } from '@brainstrike/ui';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import { useCallback } from 'react';
import { serializeDiagnosticJson } from './log-diagnostic-metadata';

interface UseLogExportOptions {
  readonly getExportRecords: () => readonly LogRecord[];
  readonly sourceCoverage: (records: readonly LogRecord[]) => Record<string, number>;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

export function useLogExport({
  getExportRecords,
  sourceCoverage,
  toast,
}: UseLogExportOptions): () => Promise<void> {
  return useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }
    const records = getExportRecords();
    if (records.length === 0) {
      return;
    }
    try {
      const blob = new Blob(
        [
          serializeDiagnosticJson(
            {
              exportedAt: new Date().toISOString(),
              recordCount: records.length,
              records,
              sourceCoverage: sourceCoverage(records),
            },
            'Log export',
            2
          ),
        ],
        { type: 'application/json' }
      );
      await downloadBlobFile({
        blob,
        filename: formatTimestampedDownloadFilename({
          extension: 'json',
          generatedAt: new Date(),
          name: 'brainstrike-logs',
        }),
      });
    } catch (error) {
      toast({
        description: describeBoundaryError(error),
        title: 'Failed to export logs',
        variant: 'destructive',
      });
    }
  }, [getExportRecords, sourceCoverage, toast]);
}
