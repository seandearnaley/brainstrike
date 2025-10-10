import { useLoggingPreferencesStore } from '@brainstrike/preferences';
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
import { type LoggingPreferences, LogLevel } from '@brainstrike/utils';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

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
  fileLoggingSupported: boolean;
  canSelectDestination: boolean;
  reason?: string | null;
  defaultDestination?: string | null;
}

export interface LoggingSettingsSectionProps {
  runtime: 'browser' | 'electron-renderer';
  fileCapabilities?: FileCapabilities;
  busy?: boolean;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  onSelectLogDestination?: () => Promise<string | null>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
}

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
      label: 'Not configured',
      hint: `Default path will be used: ${fallback}`,
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
        const message = error instanceof Error ? error.message : String(error);
        toast({
          title: 'Failed to update logging preferences',
          description: message,
          variant: 'destructive',
        });
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    [onCommitPreferences, setPreferences, toast]
  );

  const clonePreferences = useCallback((prefs: LoggingPreferences): LoggingPreferences => {
    return {
      ...prefs,
      redactPaths: [...prefs.redactPaths],
      file: { ...prefs.file },
    };
  }, []);

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
    try {
      setIsSyncing(true);
      const selected = await onSelectLogDestination();
      if (!selected) {
        return;
      }
      await applyNestedUpdates({ destination: selected, enabled: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Failed to update log destination',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsSyncing(false);
    }
  }, [applyNestedUpdates, onSelectLogDestination, toast]);

  const handleOpenDestination = useCallback(async () => {
    if (!onOpenLogDestination) {
      return;
    }
    const currentDestination = preferences.file.destination;
    const success = await onOpenLogDestination(currentDestination);
    if (!success) {
      toast({
        title: 'Unable to open log file',
        description: currentDestination
          ? `Path "${currentDestination}" is not accessible.`
          : 'No log file destination is configured.',
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
    } catch (_error) {
      setPreferences(previous);
    } finally {
      setIsSyncing(false);
    }
  }, [commitPreferences, onResetPreferences, resetPreferences, setPreferences, toast]);

  const fileDestinationLabel = useMemo(
    () =>
      deriveDestinationLabel(preferences.file.destination, fileCapabilities?.defaultDestination),
    [fileCapabilities?.defaultDestination, preferences.file.destination]
  );

  return (
    <div className="space-y-6">
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
                value={preferences.level}
                onValueChange={(value) => applyUpdates({ level: value as LogLevel })}
                disabled={pending}
              >
                <SelectTrigger id="log-level">
                  <SelectValue placeholder="Select level" />
                </SelectTrigger>
                <SelectContent>{logLevelItems}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Controls which log messages are emitted at all. Lower numbers capture more detail.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="console-level">Console Output Level</Label>
              <Select
                value={preferences.consoleLevel}
                onValueChange={(value) => applyUpdates({ consoleLevel: value as LogLevel })}
                disabled={pending || !preferences.consoleEnabled}
              >
                <SelectTrigger id="console-level">
                  <SelectValue placeholder="Select level" />
                </SelectTrigger>
                <SelectContent>{logLevelItems}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Determines which messages appear in the developer console or terminal output.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
              <div>
                <Label htmlFor="console-enabled" className="flex gap-2 items-center">
                  Console Logging
                </Label>
                <p className="text-xs text-muted-foreground">
                  Enable or disable writing structured logs to the console output.
                </p>
              </div>
              <Switch
                id="console-enabled"
                checked={preferences.consoleEnabled}
                onCheckedChange={(checked) => applyUpdates({ consoleEnabled: checked })}
                disabled={pending}
              />
            </div>

            <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
              <div>
                <Label htmlFor="include-timestamp" className="flex gap-2 items-center">
                  Include Timestamp
                </Label>
                <p className="text-xs text-muted-foreground">
                  Adds ISO timestamps to every log entry for easier correlation.
                </p>
              </div>
              <Switch
                id="include-timestamp"
                checked={preferences.includeTimestamp}
                onCheckedChange={(checked) => applyUpdates({ includeTimestamp: checked })}
                disabled={pending}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {runtime === 'electron-renderer' ? (
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
              Persist structured logs to a file for long-running debugging sessions and support
              bundles.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fileCapabilities?.reason ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
                {fileCapabilities.reason}
              </div>
            ) : null}

            <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
              <div>
                <Label htmlFor="file-enabled">Enable File Logging</Label>
                <p className="text-xs text-muted-foreground">
                  Creates or appends to a structured log file on disk.
                </p>
              </div>
              <Switch
                id="file-enabled"
                checked={preferences.file.enabled}
                onCheckedChange={(checked) => applyNestedUpdates({ enabled: checked })}
                disabled={pending || fileCapabilities?.fileLoggingSupported === false}
              />
            </div>

            <div className="space-y-2">
              <Label>Destination</Label>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                <div className="flex-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm">
                  <div className="font-medium text-muted-foreground">
                    {fileDestinationLabel.label}
                  </div>
                  {fileDestinationLabel.hint ? (
                    <div className="text-xs text-muted-foreground/80">
                      {fileDestinationLabel.hint}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleSelectDestination}
                    disabled={
                      pending ||
                      !fileCapabilities?.canSelectDestination ||
                      fileCapabilities?.fileLoggingSupported === false
                    }
                  >
                    Choose…
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenDestination}
                    disabled={!preferences.file.destination}
                  >
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="file-level">File Log Level</Label>
                <Select
                  value={preferences.file.level}
                  onValueChange={(value) => applyNestedUpdates({ level: value as LogLevel })}
                  disabled={pending || !preferences.file.enabled}
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
                  <p className="text-xs text-muted-foreground">Keep history between sessions.</p>
                </div>
                <Switch
                  id="file-append"
                  checked={preferences.file.append}
                  onCheckedChange={(checked) => applyNestedUpdates({ append: checked })}
                  disabled={pending || !preferences.file.enabled}
                />
              </div>
              <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
                <div>
                  <Label htmlFor="file-mkdir">Auto-create Folders</Label>
                  <p className="text-xs text-muted-foreground">
                    Create missing directories as needed.
                  </p>
                </div>
                <Switch
                  id="file-mkdir"
                  checked={preferences.file.mkdir}
                  onCheckedChange={(checked) => applyNestedUpdates({ mkdir: checked })}
                  disabled={pending || !preferences.file.enabled}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
              id="redact-paths"
              value={preferences.redactPaths.join(', ')}
              onChange={(event) => handleRedactChange(event.target.value)}
              placeholder="apiKey, password, token"
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of keys to redact from structured logs in addition to built-in
              defaults.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <div className="font-medium text-sm">Restore Defaults</div>
              <p className="text-xs text-muted-foreground">
                Reset all logging preferences to their recommended defaults.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={pending}
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default LoggingSettingsSection;
