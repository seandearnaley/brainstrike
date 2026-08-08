import type { LogRecord } from '@brainstrike/logging';
import type { useToast } from '@brainstrike/ui';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import { useCallback } from 'react';

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
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            recordCount: records.length,
            records,
            sourceCoverage: sourceCoverage(records),
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    try {
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
        description: error instanceof Error ? error.message : String(error),
        title: 'Failed to export logs',
        variant: 'destructive',
      });
    }
  }, [getExportRecords, sourceCoverage, toast]);
}
