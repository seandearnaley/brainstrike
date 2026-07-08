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
import { FolderOpen, RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
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

export interface LoggingSettingsSectionProps {
  busy?: boolean;
  fileCapabilities?: FileCapabilities;
  logSource?: LogSourceAdapter;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
  onSelectLogDestination?: () => Promise<string | null>;
  runtime: 'browser' | 'electron-renderer';
}

export type { LogSourceAdapter };

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
}: LoggingSettingsSectionProps) {
  const preferences = useLoggingPreferencesStore((state) => state.preferences);
  const updatePreferences = useLoggingPreferencesStore((state) => state.updatePreferences);
  const setPreferences = useLoggingPreferencesStore((state) => state.setPreferences);
  const resetPreferences = useLoggingPreferencesStore((state) => state.resetPreferences);
  const [isSyncing, setIsSyncing] = useState(false);
  const { toast } = useToast();
  const updateTokenRef = useRef(0);
  const pending = busy || isSyncing;

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

  const fileDestinationLabel = useMemo(
    () =>
      deriveDestinationLabel(preferences.file.destination, fileCapabilities?.defaultDestination),
    [fileCapabilities?.defaultDestination, preferences.file.destination]
  );

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
      <LogViewer logSource={logSource} toast={toast} />
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

export default LoggingSettingsSection;
