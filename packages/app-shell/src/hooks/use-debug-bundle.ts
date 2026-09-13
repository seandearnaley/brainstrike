import type { DebugBundleBinding } from '@brainstrike/assistant-ui';
import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import { useMemo } from 'react';
import { buildThreadDebugBundle } from '../diagnostics/debug-bundle';
import { buildThreadDebugPack } from '../diagnostics/thread-debug-pack';

/**
 * Binds the assistant panel's "Copy debug bundle" button (Flight Recorder
 * capstone, Task 9) to `buildThreadDebugBundle`. Gates on the renderer's
 * optional PGlite db handle AND the active thread — unlike
 * `useRunVerdictBinding` (which takes the repository/ids as explicit params)
 * this hook reads the db handle itself via `useOptionalPGliteDatabase`,
 * mirroring `DiagnosticSinkBridge`'s capability-gating pattern; the thread id
 * is threaded in the SAME way `useRunVerdictBinding` receives its ids —
 * as a caller-supplied parameter, so this hook stays free of wrapper-only
 * derivation logic (`selectedMemoryThreadId`).
 */
export function useDebugBundleBinding(
  threadId: string | null | undefined
): DebugBundleBinding | null {
  const db = useOptionalPGliteDatabase();

  return useMemo(() => {
    if (!(db && threadId)) {
      return null;
    }
    return {
      buildBundle: ({ runId }: { runId: string | null }) =>
        buildThreadDebugBundle(db, { threadId, ...(runId ? { runId } : {}) }),
      buildThreadPack: () => buildThreadDebugPack(db, threadId),
    };
  }, [db, threadId]);
}
