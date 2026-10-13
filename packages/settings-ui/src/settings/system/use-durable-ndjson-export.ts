import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import type { useToast } from '@brainstrike/ui';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import { useCallback, useState } from 'react';
import type { DurableNdjsonExportResult } from './logging-settings-types';

interface UseDurableNdjsonExportOptions {
  readonly onExportDurableNdjson?: (() => Promise<DurableNdjsonExportResult>) | undefined;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

export function useDurableNdjsonExport({
  onExportDurableNdjson,
  toast,
}: UseDurableNdjsonExportOptions): {
  readonly handleExportDurableNdjson: () => Promise<void>;
  readonly isExportingDurableNdjson: boolean;
} {
  const [isExportingDurableNdjson, setIsExportingDurableNdjson] = useState(false);

  // Guard the DOM before doing the bounded query, and explain an empty result
  // visibly. The trailing reset avoids a finally clause, which blocks React
  // Compiler memoization (react-hooks-js/todo); the catch never rethrows.
  const handleExportDurableNdjson = useCallback(async () => {
    if (!onExportDurableNdjson || typeof window === 'undefined') {
      return;
    }
    setIsExportingDurableNdjson(true);
    try {
      const { exportedCount, ndjson, totalCount, truncated } = await onExportDurableNdjson();
      if (ndjson.length === 0) {
        toast({
          description: 'There are no durable warn+ events to export.',
          title: 'No diagnostics to export',
        });
      } else {
        await downloadBlobFile({
          blob: new Blob([ndjson], { type: 'application/x-ndjson' }),
          filename: formatTimestampedDownloadFilename({
            extension: 'ndjson',
            generatedAt: new Date(),
            name: 'brainstrike-errors',
            suffix: truncated ? `recent${exportedCount}` : null,
          }),
        });
        if (truncated) {
          toast({
            description: `Exported the most recent ${exportedCount} of ${totalCount} warn+ events. Older events were not included.`,
            title: 'Export truncated',
          });
        }
      }
    } catch (error) {
      const message = describeBoundaryError(error);
      toast({
        description: message,
        title: 'Failed to export diagnostics',
        variant: 'destructive',
      });
    }
    setIsExportingDurableNdjson(false);
  }, [onExportDurableNdjson, toast]);

  return { handleExportDurableNdjson, isExportingDurableNdjson };
}
