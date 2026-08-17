import type { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';

// Mirrors the per-delete cap in DiagnosticEventsRepository.purge(). A result
// at this threshold may mean another bounded purge pass is required.
const DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD = 500;

interface UseDiagnosticsPurgeActionOptions {
  readonly onPurgeNow?: (() => Promise<number>) | undefined;
  readonly toast: ReturnType<typeof useToast>['toast'];
}

export function useDiagnosticsPurgeAction({
  onPurgeNow,
  toast,
}: UseDiagnosticsPurgeActionOptions): {
  readonly handlePurgeNow: () => Promise<void>;
  readonly isPurgingNow: boolean;
} {
  const [isPurgingNow, setIsPurgingNow] = useState(false);

  // The catch branch never rethrows, so the trailing reset runs on both paths.
  // A finally clause blocks React Compiler memoization (react-hooks-js/todo).
  const handlePurgeNow = useCallback(async () => {
    if (!onPurgeNow) {
      return;
    }
    setIsPurgingNow(true);
    try {
      const deletedCount = await onPurgeNow();
      toast({
        description:
          deletedCount >= DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD
            ? `Purged ${deletedCount} diagnostic events (more may remain; run again).`
            : `Purged ${deletedCount} diagnostic events.`,
        title: 'Diagnostics purged',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        description: message,
        title: 'Failed to purge diagnostic events',
        variant: 'destructive',
      });
    }
    setIsPurgingNow(false);
  }, [onPurgeNow, toast]);

  return { handlePurgeNow, isPurgingNow };
}
