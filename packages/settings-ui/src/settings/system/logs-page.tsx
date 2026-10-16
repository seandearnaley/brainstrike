import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { DiagnosticSinkHealthBanner } from './diagnostic-sink-health-banner';
import type { LogSourceAdapter } from './log-viewer-components/log-source-adapter';
import { LogViewer } from './log-viewer-components/log-viewer';
import type { DurableNdjsonExportResult } from './logging-settings-types';
import { useDurableNdjsonExport } from './use-durable-ndjson-export';

type LogSourceMode = 'persistent' | 'session';

const DURABLE_EMPTY_STATE_TEXT = 'No durable warn+ events recorded.';

export interface LogsPageProps {
  /** A hidden workspace tab stays mounted, so the page reads its source only while shown. */
  readonly active: boolean;
  readonly durableLogSource?: LogSourceAdapter;
  readonly logSource: LogSourceAdapter;
  /** Callers backed by `useDurableLogSource()` pass `() => durableLogSource.exportNdjson()`. */
  readonly onExportDurableNdjson?: () => Promise<DurableNdjsonExportResult>;
  /**
   * The only user-visible path for a broken durable sink: sink-scope records are
   * excluded from both converters, so without it a disabled sink looks healthy and empty.
   */
  readonly sinkHealthReason?: string | null;
}

/**
 * The Logs workspace tab (BST-1791): the log viewer fills the pane, and its
 * list is the page's only scroller. Settings keeps the logging configuration.
 */
export function LogsPage({
  active,
  durableLogSource,
  logSource,
  onExportDurableNdjson,
  sinkHealthReason,
}: LogsPageProps) {
  const [mode, setMode] = useState<LogSourceMode>('session');
  const { toast } = useToast();
  const { handleExportDurableNdjson, isExportingDurableNdjson } = useDurableNdjsonExport({
    onExportDurableNdjson,
    toast,
  });
  const persistent = Boolean(durableLogSource) && mode === 'persistent';
  const source = persistent ? durableLogSource : logSource;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="logs-page">
      {sinkHealthReason ? (
        <div className="p-2 pb-0">
          <DiagnosticSinkHealthBanner reason={sinkHealthReason} />
        </div>
      ) : null}
      {durableLogSource ? (
        <div className="flex flex-wrap items-center gap-2 border-border/40 border-b px-2 py-1.5">
          <Label className="text-xs" htmlFor="log-source-mode">
            Log Source
          </Label>
          <Select onValueChange={(value) => setMode(value as LogSourceMode)} value={mode}>
            <SelectTrigger className="h-8 w-[11rem]" id="log-source-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="session">Session</SelectItem>
              <SelectItem value="persistent">Persistent errors</SelectItem>
            </SelectContent>
          </Select>
          {persistent && onExportDurableNdjson ? (
            <Button
              className="h-8"
              disabled={isExportingDurableNdjson}
              onClick={handleExportDurableNdjson}
              size="sm"
              type="button"
              variant="outline"
            >
              <Download aria-hidden="true" className="mr-2 h-4 w-4" />
              Export NDJSON
            </Button>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {persistent
              ? 'Durable warn+ events stored in the database.'
              : 'In-memory logs since launch.'}
          </p>
        </div>
      ) : null}
      <LogViewer
        logSource={active ? source : undefined}
        toast={toast}
        {...(persistent ? { emptyStateText: DURABLE_EMPTY_STATE_TEXT } : {})}
      />
    </div>
  );
}
