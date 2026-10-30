import type { LogRecord } from '@brainstrike/logging';
import { saveDownload } from '@brainstrike/ui';
import { formatTimestampedDownloadFilename } from '@brainstrike/utils/browser-download';
import { useCallback } from 'react';
import { serializeDiagnosticJson } from './log-diagnostic-metadata';

interface UseLogExportOptions {
  readonly getExportRecords: () => readonly LogRecord[];
  readonly sourceCoverage: (records: readonly LogRecord[]) => Record<string, number>;
}

export function useLogExport({
  getExportRecords,
  sourceCoverage,
}: UseLogExportOptions): () => Promise<void> {
  return useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }
    const records = getExportRecords();
    if (records.length === 0) {
      return;
    }
    await saveDownload({
      build: () => ({
        blob: new Blob(
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
        ),
        filename: formatTimestampedDownloadFilename({
          extension: 'json',
          generatedAt: new Date(),
          name: 'brainstrike-logs',
        }),
      }),
      what: 'logs',
    });
  }, [getExportRecords, sourceCoverage]);
}
