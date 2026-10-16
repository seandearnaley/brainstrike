import {
  LogsWorkspacePage,
  useDiagnosticSinkHealthStore,
  useDurableLogSource,
} from '@brainstrike/app-shell/diagnostics';
import type { LogSourceAdapter } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import { useMemo } from 'react';
import { getWebLogBuffer } from '../log-buffer';

/** The web Logs workspace tab (BST-1791): this tab's in-memory log buffer. */
export function LogsPageContent() {
  const logSource = useMemo<LogSourceAdapter>(() => {
    const buffer = getWebLogBuffer();
    return {
      getInitialRecords: async () => buffer.getRecords(),
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);
  const durableLogSource = useDurableLogSource();
  const sinkHealthReason = useDiagnosticSinkHealthStore((state) => state.disabledReason);
  return (
    <LogsWorkspacePage
      logSource={logSource}
      sinkHealthReason={sinkHealthReason}
      {...(durableLogSource === undefined
        ? {}
        : {
            durableLogSource,
            onExportDurableNdjson: () => durableLogSource.exportNdjson(),
          })}
    />
  );
}
