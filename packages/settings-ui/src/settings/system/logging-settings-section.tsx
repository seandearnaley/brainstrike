import {
  DIAGNOSTICS_RETENTION_DAY_OPTIONS,
  DIAGNOSTICS_RETENTION_ROW_OPTIONS,
  diagnosticsRetentionSelectors,
  useDiagnosticsRetentionStore,
} from '@brainstrike/app-state/stores/diagnostics-retention-store';
import type { LoggingPreferences } from '@brainstrike/logging';
import { LogLevel } from '@brainstrike/logging';
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
import { FolderOpen, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { DiagnosticSinkHealthBanner } from './diagnostic-sink-health-banner';
import type { FileCapabilities, LoggingSettingsSectionProps } from './logging-settings-types';
import { useDiagnosticsPurgeAction } from './use-diagnostics-purge-action';
import { useLoggingPreferencesSync } from './use-logging-preferences-sync';

const LOG_LEVEL_OPTIONS: LogLevel[] = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
  LogLevel.SILENT,
];

export type { LogSourceAdapter } from './log-viewer-components/log-source-adapter';
export type {
  DurableNdjsonExportResult,
  FileCapabilities,
  LoggingSettingsSectionProps,
} from './logging-settings-types';

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
  onOpenLogs,
  onPurgeNow,
  sinkHealthReason,
}: LoggingSettingsSectionProps) {
  const { toast } = useToast();
  const {
    applyNestedUpdates,
    applyUpdates,
    handleOpenDestination,
    handleRedactChange,
    handleReset,
    handleSelectDestination,
    isSyncing,
    preferences,
  } = useLoggingPreferencesSync({
    onCommitPreferences,
    onOpenLogDestination,
    onResetPreferences,
    onSelectLogDestination,
    toast,
  });
  const { handlePurgeNow, isPurgingNow } = useDiagnosticsPurgeAction({ onPurgeNow, toast });
  const pending = busy || isSyncing;

  const logLevelItems = useMemo(
    () =>
      LOG_LEVEL_OPTIONS.map((level) => (
        <SelectItem key={level} value={level}>
          {formatLogLevel(level)}
        </SelectItem>
      )),
    []
  );

  const fileDestinationLabel = useMemo(
    () =>
      deriveDestinationLabel(preferences.file.destination, fileCapabilities?.defaultDestination),
    [fileCapabilities?.defaultDestination, preferences.file.destination]
  );

  return (
    <div className="space-y-6">
      {sinkHealthReason ? <DiagnosticSinkHealthBanner reason={sinkHealthReason} /> : null}
      {onOpenLogs ? <OpenLogsCard onOpenLogs={onOpenLogs} /> : null}
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
      <DiagnosticsRetentionCard
        {...(onPurgeNow ? { onPurgeNow: handlePurgeNow } : {})}
        isPurgingNow={isPurgingNow}
        pending={pending}
      />
    </div>
  );
}

/** The log viewer is its own workspace tab (BST-1791); Settings links to it. */
function OpenLogsCard({ onOpenLogs }: { onOpenLogs: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Logs</CardTitle>
          <CardDescription>
            Application and diagnostic logs open in their own workspace tab.
          </CardDescription>
        </div>
        <Button onClick={onOpenLogs} size="sm" type="button" variant="outline">
          <ScrollText aria-hidden="true" className="mr-2 h-4 w-4" />
          Open Logs
        </Button>
      </CardHeader>
    </Card>
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
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-warning text-xs">
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
  onPurgeNow?: () => Promise<void>;
  pending: boolean;
}

/** Flight Recorder P2b Task 4: retention thresholds (bound to the
 * `diagnostics-retention-store` persisted store) plus an on-demand "Purge
 * now" action when the database capability is available. */
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

        {onPurgeNow ? (
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
        ) : (
          <p className="rounded-md border border-border/60 p-3 text-muted-foreground text-xs">
            These limits apply once the local database is available.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default LoggingSettingsSection;
