import {
  LogsWorkspacePage,
  useDiagnosticSinkHealthStore,
} from '@brainstrike/app-shell/diagnostics';
import { useMemo } from 'react';
import { createDesktopLogSource } from '../desktop-log-source';

/** The desktop Logs workspace tab (BST-1791). */
export function LogsPageContent() {
  const logSource = useMemo(() => createDesktopLogSource(), []);
  const sinkHealthReason = useDiagnosticSinkHealthStore((state) => state.disabledReason);
  return <LogsWorkspacePage logSource={logSource} sinkHealthReason={sinkHealthReason} />;
}
