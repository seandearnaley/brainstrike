import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast,
} from '@brainstrike/ui';
import { LogLevel } from '@brainstrike/utils/logger';
import type { LoggingPreferences } from '@brainstrike/utils/logging-preferences';
import { Download, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import {
  DIAGNOSTICS_RETENTION_DAY_OPTIONS,
  DIAGNOSTICS_RETENTION_ROW_OPTIONS,
  diagnosticsRetentionSelectors,
  useDiagnosticsRetentionStore,
} from '../../stores/diagnostics-retention-store';
import { useLoggingPreferencesStore } from '../../stores/logging-preferences-store';
import { type LogSourceAdapter, LogViewer } from './log-viewer-components/log-viewer';

const LOG_LEVEL_OPTIONS: LogLevel[] = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
  LogLevel.SILENT,
];

interface FileCapabilities {
  canSelectDestination: boolean;
  defaultDestination?: string | null;
  fileLoggingSupported: boolean;
  reason?: string | null;
}

/**
 * Structural mirror of `@brainstrike/app-shell`'s `DurableLogExportResult`
 * (`packages/app-shell/src/diagnostics/durable-log-source.ts`) — declared
 * locally rather than imported, same reason as `onExportDurableNdjson`'s doc
 * comment below: `app-shell` already depends on `preferences`, so importing
 * its type here would be circular. TypeScript's structural typing makes the
 * duplication safe as long as the shapes stay in sync.
 */
export interface DurableNdjsonExportResult {
  readonly exportedCount: number;
  readonly ndjson: string;
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface LoggingSettingsSectionProps {
  busy?: boolean;
  durableLogSource?: LogSourceAdapter;
  fileCapabilities?: FileCapabilities;
  logSource?: LogSourceAdapter;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  /**
   * Exports the durable source's bounded query as NDJSON text (Flight
   * Recorder P2a Task 6) for the "Export NDJSON" button, rendered only when
   * both this and `durableLogSource` are present and Persistent errors is
   * selected. Threaded as a standalone callback rather than widening
   * `durableLogSource` to `app-shell`'s `DurableLogSource` type: `app-shell`
   * already depends on `preferences`, so importing app-shell's type here
   * would be circular. Callers that build `durableLogSource` from
   * `useDurableLogSource()` (which returns the widened adapter) pass
   * `() => durableLogSource.exportNdjson()` for this prop.
   */
  onExportDurableNdjson?: () => Promise<DurableNdjsonExportResult>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  /**
   * Purges diagnostic events past the user's configured retention limits
   * (Flight Recorder P2b Task 4) and resolves with the deleted row count,
   * for the Diagnostics Retention card's "Purge now" button. Threaded as a
   * callback prop for the same reason as `onExportDurableNdjson` above:
   * `app-shell` already depends on `preferences`, so a repository import
   * here would be circular. Callers build this from
   * `useDiagnosticsPurge()` (`@brainstrike/app-shell/diagnostics`), which
   * wraps `DiagnosticEventsRepository.purge()` with the Task 1 store's
   * `maxAgeDays`/`maxRows`. The card renders only when this prop is
   * present.
   */
  onPurgeNow?: () => Promise<number>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
  onSelectLogDestination?: () => Promise<string | null>;
  runtime: 'browser' | 'electron-renderer';
}

export type { LogSourceAdapter };

type LogSourceMode = 'persistent' | 'session';

const DURABLE_EMPTY_STATE_TEXT = 'No durable warn+ events recorded.';

/**
 * Mirrors `DIAGNOSTIC_EVENTS_PURGE_LIMIT` in
 * `packages/db/src/repositories/diagnostic-events-repository.ts` (500 rows
 * per delete inside `purge()`). Hardcoded rather than imported for the same
 * reason `diagnostics-retention-store.ts` hardcodes its own defaults: this
 * file must not import `@brainstrike/db`'s heavy barrel (`onPurgeNow` is a
 * callback prop precisely to avoid that). Used only as a heuristic for
 * whether a purge may not have fully drained a large backlog — a returned
 * count at or above this threshold means at least one of `purge()`'s two
 * independently-capped deletes (aged rows / over-cap rows) hit its limit,
 * so more rows may remain (`>=`, not `===`: both deletes can each
 * independently reach this cap in the same call, so the total can exceed it
 * without either alone equaling it). Drift is caught test-side:
 * `logging-settings-section.test.tsx` resolves `onPurgeNow` with the REAL
 * exported `DIAGNOSTIC_EVENTS_PURGE_LIMIT` and asserts the "may remain"
 * toast copy, so a divergence here fails RED instead of silently
 * under-warning.
 */
const DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD = 500;

function formatLogLevel(level: LogLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
}

function deriveDestinationLabel(
  destination: string | null,
  fallback?: string | null
): { label: string; hint?: string } {
  if (destination) {
    return { label: destination };
  }
  if (fallback) {
    return {
      hint: `Default path will be used: ${fallback}`,
      label: 'Not configured',
    };
  }
  return { label: 'Not configured' };
}

export function LoggingSettingsSection({
  runtime,
  fileCapabilities,
  busy = false,
  onCommitPreferences,
  onSelectLogDestination,
  onOpenLogDestination,
  onResetPreferences,
  logSource,
  durableLogSource,
  onExportDurableNdjson,
  onPurgeNow,
}: LoggingSettingsSectionProps) {
  const preferences = useLoggingPreferencesStore((state) => state.preferences);
  const updatePreferences = useLoggingPreferencesStore((state) => state.updatePreferences);
  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const resetPreferences = useLoggingPreferencesStore((state) => state.resetPreferences);
  const [isSyncing, setIsSyncing] = useState(false);
  const [logSourceMode, setLogSourceMode] = useState<LogSourceMode>('session');
  const [isExportingDurableNdjson, setIsExportingDurableNdjson] = useState(false);
  const [isPurgingNow, setIsPurgingNow] = useState(false);
  const { toast } = useToast();
  const updateTokenRef = useRef(0);
  const pending = busy || isSyncing;
  const usingDurableLogSource = Boolean(durableLogSource) && logSourceMode === 'persistent';
  const activeLogSource = usingDurableLogSource ? durableLogSource : logSource;
  const activeEmptyStateText = usingDurableLogSource ? DURABLE_EMPTY_STATE_TEXT : undefined;

  const commitPreferences = useCallback(
    async (nextPreferences: LoggingPreferences) => {
      if (!onCommitPreferences) {
        return;
      }
      setIsSyncing(true);
      try {
        const result = await onCommitPreferences(nextPreferences);
        if (result) {
          setPreferences(result);
        }
      } catch (error) {
        setIsSyncing(false);
        const message = error instanceof Error ? error.message : String(error);
        toast({
          description: message,
          title: 'Failed to update logging preferences',
          variant: 'destructive',
        });
        throw error;
      }
      setIsSyncing(false);
    },
    [onCommitPreferences, setPreferences, toast]
  );

  const clonePreferences = useCallback(
    (prefs: LoggingPreferences): LoggingPreferences => ({
      ...prefs,
      file: { ...prefs.file },
      redactPaths: [...prefs.redactPaths],
    }),
    []
  );

  const applyUpdates = useCallback(
    async (updates: Partial<LoggingPreferences>) => {
      const previous = clonePreferences(useLoggingPreferencesStore.getState().preferences);
      updatePreferences(updates);
      const requestId = updateTokenRef.current + 1;
      updateTokenRef.current = requestId;
      const next = clonePreferences(useLoggingPreferencesStore.getState().preferences);
      try {
        await commitPreferences(next);
      } catch {
        if (updateTokenRef.current === requestId) {
          setPreferences(previous);
        }
      }
    },
    [clonePreferences, commitPreferences, setPreferences, updatePreferences]
  );

  const applyNestedUpdates = useCallback(
    async (updates: Partial<LoggingPreferences['file']>) => {
      await applyUpdates({ file: { ...preferences.file, ...updates } });
    },
    [applyUpdates, preferences.file]
  );

  const logLevelItems = useMemo(
    () =>
      LOG_LEVEL_OPTIONS.map((level) => (
        <SelectItem key={level} value={level}>
          {formatLogLevel(level)}
        </SelectItem>
      )),
    []
  );

  const handleRedactChange = useCallback(
    async (value: string) => {
      const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      await applyUpdates({ redactPaths: entries });
    },
    [applyUpdates]
  );

  const handleSelectDestination = useCallback(async () => {
    if (!onSelectLogDestination) {
      return;
    }
    setIsSyncing(true);
    try {
      const selected = await onSelectLogDestination();
      if (!selected) {
        setIsSyncing(false);
        return;
      }
      await applyNestedUpdates({ destination: selected, enabled: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        description: message,
        title: 'Failed to update log destination',
        variant: 'destructive',
      });
    }
    setIsSyncing(false);
  }, [applyNestedUpdates, onSelectLogDestination, toast]);

  const handleOpenDestination = useCallback(async () => {
    if (!onOpenLogDestination) {
      return;
    }
    const currentDestination = preferences.file.destination;
    const success = await onOpenLogDestination(currentDestination);
    if (!success) {
      toast({
        description: currentDestination
          ? `Path "${currentDestination}" is not accessible.`
          : 'No log file destination is configured.',
        title: 'Unable to open log file',
        variant: 'destructive',
      });
    }
  }, [onOpenLogDestination, preferences.file.destination, toast]);

  const handleReset = useCallback(async () => {
    const previous = useLoggingPreferencesStore.getState().preferences;
    resetPreferences();
    const next = useLoggingPreferencesStore.getState().preferences;
    try {
      if (onResetPreferences) {
        setIsSyncing(true);
        await onResetPreferences(next);
      }
      await commitPreferences(next);
      toast({ title: 'Logging preferences reset' });
    } catch (error) {
      setPreferences(previous);
      toast({
        description: error instanceof Error ? error.message : 'Unknown error occurred.',
        title: 'Failed to reset logging preferences',
        variant: 'destructive',
      });
    }
    setIsSyncing(false);
  }, [commitPreferences, onResetPreferences, resetPreferences, setPreferences, toast]);

  // Same shape as `handleReset` above: the catch branch never rethrows, so
  // `setIsPurgingNow(false)` unconditionally after the try/catch is reached
  // on both the success and failure paths — no `finally` needed (a
  // `TryStatement` with a `finally` clause blocks React Compiler's automatic
  // memoization for this whole component, react-doctor `react-hooks-js/todo`,
  // error severity — the same rule that failed a required check on P2a's
  // `handleExportDurableNdjson`).
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

  const fileDestinationLabel = useMemo(
    () =>
      deriveDestinationLabel(preferences.file.destination, fileCapabilities?.defaultDestination),
    [fileCapabilities?.defaultDestination, preferences.file.destination]
  );

  // Mirrors `handleExportLogs` in log-viewer.tsx: Blob -> object URL ->
  // anchor click -> revoke. This is the honest web equivalent of the
  // desktop rotating `brainstrike-errors.ndjson` file (design doc §7). The
  // export promise is awaited unwrapped (no try/catch inside
  // `onExportDurableNdjson` itself) so a query rejection surfaces here and
  // gets a visible toast rather than silently producing an empty download.
  // Like `handleExportLogs`, an empty result skips the download — but
  // (unlike that silent early-return) tells the user why via a
  // non-destructive toast, since "nothing happened" is otherwise
  // indistinguishable from a broken button. `isExportingDurableNdjson`
  // guards against rapid double-clicks firing concurrent exports, each
  // re-querying up to `DURABLE_LOG_SOURCE_MAX_ROWS` rows.
  //
  // The DOM guard runs BEFORE the query (matching `handleExportLogs`), not
  // after: awaiting a full bounded query only to discard the result in a
  // non-DOM environment would run real work for nothing. No `try/finally`
  // here on purpose — a `TryStatement` with a `finally` clause blocks React
  // Compiler's automatic memoization for this whole component (react-doctor
  // `react-hooks-js/todo`, error severity). `setIsExportingDurableNdjson(false)`
  // instead runs unconditionally right after the try/catch: the catch branch
  // never rethrows, so that line is reached on both the success and failure
  // paths exactly like a `finally` would, without the compiler-blocking
  // construct.
  const handleExportDurableNdjson = useCallback(async () => {
    if (!onExportDurableNdjson) {
      return;
    }
    if (typeof window === 'undefined') {
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
        const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        // Truncation is visible in two places, never silently: the filename
        // itself (so it survives outside this session, e.g. in a Downloads
        // folder) and the toast below (with the exact N of M counts). The
        // NDJSON body stays pure NDJSON — no metadata line — so "every line
        // is a diagnostic event" still holds for the file contents.
        anchor.download = truncated
          ? `brainstrike-errors-${new Date().toISOString()}-recent${exportedCount}.ndjson`
          : `brainstrike-errors-${new Date().toISOString()}.ndjson`;
        anchor.click();
        URL.revokeObjectURL(url);
        if (truncated) {
          toast({
            description: `Exported the most recent ${exportedCount} of ${totalCount} warn+ events. Older events were not included.`,
            title: 'Export truncated',
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        description: message,
        title: 'Failed to export diagnostics',
        variant: 'destructive',
      });
    }
    setIsExportingDurableNdjson(false);
  }, [onExportDurableNdjson, toast]);

  return (
    <div className="space-y-6">
      <GeneralLoggingCard
        applyUpdates={applyUpdates}
        logLevelItems={logLevelItems}
        pending={pending}
        preferences={preferences}
      />
      {runtime === 'electron-renderer' ? (
        <FileLoggingCard
          applyNestedUpdates={applyNestedUpdates}
          fileCapabilities={fileCapabilities}
          fileDestinationLabel={fileDestinationLabel}
          logLevelItems={logLevelItems}
          onOpenDestination={handleOpenDestination}
          onSelectDestination={handleSelectDestination}
          pending={pending}
          preferences={preferences}
        />
      ) : null}
      <AdvancedLoggingCard
        onRedactChange={handleRedactChange}
        onReset={handleReset}
        pending={pending}
        preferences={preferences}
      />
      {onPurgeNow ? (
        <DiagnosticsRetentionCard
          isPurgingNow={isPurgingNow}
          onPurgeNow={handlePurgeNow}
          pending={pending}
        />
      ) : null}
      {durableLogSource ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
          <div>
            <Label htmlFor="log-source-mode">Log Source</Label>
            <p className="text-muted-foreground text-xs">
              Session shows in-memory logs since launch. Persistent errors reads durable warn+
              events stored in the database.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(value) => setLogSourceMode(value as LogSourceMode)}
              value={logSourceMode}
            >
              <SelectTrigger className="w-[200px]" id="log-source-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="session">Session</SelectItem>
                <SelectItem value="persistent">Persistent errors</SelectItem>
              </SelectContent>
            </Select>
            {usingDurableLogSource && onExportDurableNdjson ? (
              <Button
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
          </div>
        </div>
      ) : null}
      <LogViewer
        logSource={activeLogSource}
        toast={toast}
        {...(activeEmptyStateText === undefined ? {} : { emptyStateText: activeEmptyStateText })}
      />
    </div>
  );
}

interface GeneralLoggingCardProps {
  applyUpdates: (updates: Partial<LoggingPreferences>) => Promise<void>;
  logLevelItems: ReactNode;
  pending: boolean;
  preferences: LoggingPreferences;
}

function GeneralLoggingCard({
  applyUpdates,
  logLevelItems,
  pending,
  preferences,
}: GeneralLoggingCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>General Logging</CardTitle>
        <CardDescription>
          Control verbosity and console output for application logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="log-level">Global Log Level</Label>
            <Select
              disabled={pending}
              onValueChange={(value) => applyUpdates({ level: value as LogLevel })}
              value={preferences.level}
            >
              <SelectTrigger id="log-level">
                <SelectValue placeholder="Select level" />
              </SelectTrigger>
              <SelectContent>{logLevelItems}</SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Controls which log messages are emitted at all. Lower numbers capture more detail.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="console-level">Console Output Level</Label>
            <Select
              disabled={pending || !preferences.consoleEnabled}
              onValueChange={(value) => applyUpdates({ consoleLevel: value as LogLevel })}
              value={preferences.consoleLevel}
            >
              <SelectTrigger id="console-level">
                <SelectValue placeholder="Select level" />
              </SelectTrigger>
              <SelectContent>{logLevelItems}</SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Determines which messages appear in the developer console or terminal output.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="flex items-center gap-2" htmlFor="console-enabled">
                Console Logging
              </Label>
              <p className="text-muted-foreground text-xs">
                Enable or disable writing structured logs to the console output.
              </p>
            </div>
            <Switch
              checked={preferences.consoleEnabled}
              disabled={pending}
              id="console-enabled"
              onCheckedChange={(checked) => applyUpdates({ consoleEnabled: checked })}
            />
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label className="flex items-center gap-2" htmlFor="include-timestamp">
                Include Timestamp
              </Label>
              <p className="text-muted-foreground text-xs">
                Adds ISO timestamps to every log entry for easier correlation.
              </p>
            </div>
            <Switch
              checked={preferences.includeTimestamp}
              disabled={pending}
              id="include-timestamp"
              onCheckedChange={(checked) => applyUpdates({ includeTimestamp: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface FileLoggingCardProps {
  applyNestedUpdates: (updates: Partial<LoggingPreferences['file']>) => Promise<void>;
  fileCapabilities: FileCapabilities | undefined;
  fileDestinationLabel: { label: string; hint?: string };
  logLevelItems: ReactNode;
  onOpenDestination: () => Promise<void>;
  onSelectDestination: () => Promise<void>;
  pending: boolean;
  preferences: LoggingPreferences;
}

function FileLoggingCard({
  applyNestedUpdates,
  fileCapabilities,
  fileDestinationLabel,
  logLevelItems,
  onOpenDestination,
  onSelectDestination,
  pending,
  preferences,
}: FileLoggingCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>File Logging</CardTitle>
          {preferences.file.enabled ? (
            <Badge variant="secondary">enabled</Badge>
          ) : (
            <Badge variant="outline">disabled</Badge>
          )}
        </div>
        <CardDescription>
          Persist structured logs to a file for long-running debugging sessions and support bundles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fileCapabilities?.reason ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-amber-900 text-xs dark:text-amber-200">
            {fileCapabilities.reason}
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
          <div>
            <Label htmlFor="file-enabled">Enable File Logging</Label>
            <p className="text-muted-foreground text-xs">
              Creates or appends to a structured log file on disk.
            </p>
          </div>
          <Switch
            checked={preferences.file.enabled}
            disabled={pending || fileCapabilities?.fileLoggingSupported === false}
            id="file-enabled"
            onCheckedChange={(checked) => applyNestedUpdates({ enabled: checked })}
          />
        </div>

        <div className="space-y-2">
          <Label>Destination</Label>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
            <div className="flex-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium text-muted-foreground">{fileDestinationLabel.label}</div>
              {fileDestinationLabel.hint ? (
                <div className="text-muted-foreground/80 text-xs">{fileDestinationLabel.hint}</div>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                disabled={
                  pending ||
                  !fileCapabilities?.canSelectDestination ||
                  fileCapabilities?.fileLoggingSupported === false
                }
                onClick={onSelectDestination}
                size="sm"
                type="button"
                variant="outline"
              >
                Choose…
              </Button>
              <Button
                disabled={!preferences.file.destination}
                onClick={onOpenDestination}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpen aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="file-level">File Log Level</Label>
            <Select
              disabled={pending || !preferences.file.enabled}
              onValueChange={(value) => applyNestedUpdates({ level: value as LogLevel })}
              value={preferences.file.level}
            >
              <SelectTrigger id="file-level">
                <SelectValue placeholder="Select level" />
              </SelectTrigger>
              <SelectContent>{logLevelItems}</SelectContent>
            </Select>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label htmlFor="file-append">Append Mode</Label>
              <p className="text-muted-foreground text-xs">Keep history between sessions.</p>
            </div>
            <Switch
              checked={preferences.file.append}
              disabled={pending || !preferences.file.enabled}
              id="file-append"
              onCheckedChange={(checked) => applyNestedUpdates({ append: checked })}
            />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div>
              <Label htmlFor="file-mkdir">Auto-create Folders</Label>
              <p className="text-muted-foreground text-xs">Create missing directories as needed.</p>
            </div>
            <Switch
              checked={preferences.file.mkdir}
              disabled={pending || !preferences.file.enabled}
              id="file-mkdir"
              onCheckedChange={(checked) => applyNestedUpdates({ mkdir: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface AdvancedLoggingCardProps {
  onRedactChange: (value: string) => Promise<void>;
  onReset: () => Promise<void>;
  pending: boolean;
  preferences: LoggingPreferences;
}

function AdvancedLoggingCard({
  onRedactChange,
  onReset,
  pending,
  preferences,
}: AdvancedLoggingCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced</CardTitle>
        <CardDescription>
          Configure structured logging safeguards and sensitive field redaction.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="redact-paths">Redacted Fields</Label>
          <Input
            disabled={pending}
            id="redact-paths"
            onChange={(event) => onRedactChange(event.target.value)}
            placeholder="apiKey, password, token"
            value={preferences.redactPaths.join(', ')}
          />
          <p className="text-muted-foreground text-xs">
            Comma-separated list of keys to redact from structured logs in addition to built-in
            defaults.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
          <div>
            <div className="font-medium text-sm">Restore Defaults</div>
            <p className="text-muted-foreground text-xs">
              Reset all logging preferences to their recommended defaults.
            </p>
          </div>
          <Button disabled={pending} onClick={onReset} size="sm" type="button" variant="outline">
            <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface DiagnosticsRetentionCardProps {
  isPurgingNow: boolean;
  onPurgeNow: () => Promise<void>;
  pending: boolean;
}

/** Flight Recorder P2b Task 4: retention thresholds (bound to the
 * `diagnostics-retention-store` persisted store) plus an on-demand "Purge
 * now" action. Rendered by the parent only when `onPurgeNow` is supplied. */
function DiagnosticsRetentionCard({
  isPurgingNow,
  onPurgeNow,
  pending,
}: DiagnosticsRetentionCardProps) {
  const maxAgeDays = useDiagnosticsRetentionStore(diagnosticsRetentionSelectors.maxAgeDays);
  const maxRows = useDiagnosticsRetentionStore(diagnosticsRetentionSelectors.maxRows);
  const setMaxAgeDays = useDiagnosticsRetentionStore((state) => state.setMaxAgeDays);
  const setMaxRows = useDiagnosticsRetentionStore((state) => state.setMaxRows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnostics Retention</CardTitle>
        <CardDescription>
          Control how long warn+ diagnostic events stay in the local database before they're purged
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="diagnostics-max-age-days">Keep Events For</Label>
            <Select
              disabled={pending}
              onValueChange={(value) => setMaxAgeDays(Number(value))}
              value={String(maxAgeDays)}
            >
              <SelectTrigger id="diagnostics-max-age-days">
                <SelectValue placeholder="Select duration" />
              </SelectTrigger>
              <SelectContent>
                {DIAGNOSTICS_RETENTION_DAY_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Diagnostic events older than this are purged automatically.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="diagnostics-max-rows">Maximum Events</Label>
            <Select
              disabled={pending}
              onValueChange={(value) => setMaxRows(Number(value))}
              value={String(maxRows)}
            >
              <SelectTrigger id="diagnostics-max-rows">
                <SelectValue placeholder="Select row limit" />
              </SelectTrigger>
              <SelectContent>
                {DIAGNOSTICS_RETENTION_ROW_OPTIONS.map((rows) => (
                  <SelectItem key={rows} value={String(rows)}>
                    {rows.toLocaleString()} events
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Oldest events beyond this count are purged automatically.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
          <div>
            <div className="font-medium text-sm">Purge Now</div>
            <p className="text-muted-foreground text-xs">
              Immediately delete diagnostic events past the limits above.
            </p>
          </div>
          <Button
            disabled={isPurgingNow}
            onClick={onPurgeNow}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />
            Purge Now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default LoggingSettingsSection;
