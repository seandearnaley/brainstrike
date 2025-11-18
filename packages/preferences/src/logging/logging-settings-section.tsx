import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@brainstrike/ui';
import { type LoggingPreferences, LogLevel, type LogRecord } from '@brainstrike/utils';
import {
  type Cell,
  type CellContext,
  type Column,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type Header,
  type HeaderGroup,
  type Table as ReactTableInstance,
  type Row,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { ChevronDown, FolderOpen, RefreshCw } from 'lucide-react';
import {
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLoggingPreferencesStore } from '../stores/logging-preferences-store';

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
  logSource?: LogSourceAdapter;
}

export interface LogSourceAdapter {
  getInitialRecords?: () => Promise<readonly LogRecord[]>;
  subscribe?: (handler: (records: readonly LogRecord[]) => void) => () => void;
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
    } catch (error) {
      setPreferences(previous);
      toast({
        title: 'Failed to reset logging preferences',
        description: error instanceof Error ? error.message : 'Unknown error occurred.',
        variant: 'destructive',
      });
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
      <LogViewerCard logSource={logSource} toast={toast} />
    </div>
  );
}

export default LoggingSettingsSection;

interface LogViewerCardProps {
  logSource: LogSourceAdapter | undefined;
  toast: ReturnType<typeof useToast>['toast'];
}

interface LogRecordRow extends LogRecord {
  serializedArgs: string;
  flattenedBindings: string;
}

function LogViewerCard({ logSource, toast }: LogViewerCardProps) {
  const [logRecords, setLogRecords] = useState<readonly LogRecord[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel>(LogLevel.DEBUG);
  const [globalFilter, setGlobalFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const tableContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!logSource) {
      setLogRecords([]);
      return;
    }
    let cancelled = false;

    if (logSource.getInitialRecords) {
      setLogsLoading(true);
      logSource
        .getInitialRecords()
        .then((initial) => {
          if (!cancelled && initial) {
            setLogRecords(sortLogRecords(initial));
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          toast({
            title: 'Failed to load logs',
            description: message,
            variant: 'destructive',
          });
        })
        .finally(() => {
          if (!cancelled) {
            setLogsLoading(false);
          }
        });
    }

    const unsubscribe = logSource.subscribe?.((records) => {
      setLogRecords(sortLogRecords(records));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [logSource, toast]);

  const filteredRecords = useMemo(() => {
    const levelIndex = Math.max(0, LOG_LEVEL_OPTIONS.indexOf(logLevelFilter));
    const term = globalFilter.trim().toLowerCase();
    return logRecords.filter((record) => {
      const recordLevelIndex = Math.max(0, LOG_LEVEL_OPTIONS.indexOf(record.level));
      if (recordLevelIndex < levelIndex) {
        return false;
      }
      if (!term) {
        return true;
      }
      const haystack = [
        record.message ?? '',
        record.scope ?? '',
        serializeArgs(record.args),
        JSON.stringify(record.bindings ?? {}),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [globalFilter, logLevelFilter, logRecords]);

  const tableData = useMemo<LogRecordRow[]>(() => {
    return filteredRecords.map((record) => ({
      ...record,
      serializedArgs: serializeArgs(record.args),
      flattenedBindings: JSON.stringify(record.bindings ?? {}),
    }));
  }, [filteredRecords]);

  const columns = useMemo<ColumnDef<LogRecordRow>[]>(
    () => [
      {
        accessorKey: 'timestamp',
        header: 'Timestamp',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => (
          <span className="text-xs text-muted-foreground">
            {formatLogTimestamp(getValue() as number)}
          </span>
        ),
        size: 120,
      },
      {
        accessorKey: 'level',
        header: 'Level',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const level = getValue() as LogLevel;
          return (
            <Badge variant={getLevelBadgeVariant(level)} className="text-[11px]">
              {level.toUpperCase()}
            </Badge>
          );
        },
        size: 100,
      },
      {
        accessorKey: 'scope',
        header: 'Scope',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const scope = getValue() as string | undefined;
          return scope ? (
            <span className="text-xs text-muted-foreground">[{scope}]</span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          );
        },
        size: 150,
      },
      {
        accessorKey: 'message',
        header: 'Message',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const message = getValue() as string | undefined;
          return (
            <div className="max-w-md truncate text-xs" title={message ?? ''}>
              {message || <span className="text-muted-foreground/50">—</span>}
            </div>
          );
        },
        size: 300,
      },
      {
        accessorKey: 'serializedArgs',
        header: 'Payload',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const payload = getValue() as string;
          return payload ? (
            <pre
              className="max-w-xs truncate text-[11px] text-muted-foreground font-mono"
              title={payload}
            >
              {payload}
            </pre>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          );
        },
        size: 250,
      },
      {
        accessorKey: 'flattenedBindings',
        header: 'Bindings',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const bindings = getValue() as string;
          const parsed = bindings && bindings !== '{}' ? bindings : null;
          return parsed ? (
            <pre
              className="max-w-xs truncate text-[11px] text-muted-foreground font-mono"
              title={parsed}
            >
              {parsed}
            </pre>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          );
        },
        size: 200,
      },
    ],
    []
  );

  const table = useReactTable({
    data: tableData,
    columns,
    state: {
      globalFilter,
      columnVisibility,
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: 'includesString',
    initialState: {
      sorting: [{ id: 'timestamp', desc: true }],
    },
  });

  const rows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();

  useEffect(() => {
    if (!autoScroll || rows.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      const container = tableContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, [autoScroll, rows.length]);

  const logLevelItems = useMemo(
    () =>
      LOG_LEVEL_OPTIONS.map((level) => (
        <SelectItem key={level} value={level}>
          {formatLogLevel(level)}
        </SelectItem>
      )),
    []
  );

  const handleRefreshLogs = useCallback(async () => {
    if (!logSource?.getInitialRecords) {
      return;
    }
    setLogsLoading(true);
    try {
      const records = await logSource.getInitialRecords();
      setLogRecords(sortLogRecords(records));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Failed to refresh logs',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setLogsLoading(false);
    }
  }, [logSource, toast]);

  const handleExportLogs = useCallback(() => {
    if (typeof window === 'undefined' || rows.length === 0) {
      return;
    }
    const exportData = rows.map((row: Row<LogRecordRow>) => row.original);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `brainstrike-logs-${new Date().toISOString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  const canRefresh = Boolean(logSource?.getInitialRecords);

  if (!logSource) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log Viewer</CardTitle>
        <CardDescription>
          Stream recent structured logs with filtering, sorting, and search.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <LogViewerToolbar
          logLevelFilter={logLevelFilter}
          onLevelChange={(value) => setLogLevelFilter(value)}
          logLevelItems={logLevelItems}
          globalFilter={globalFilter}
          onSearchChange={(value) => setGlobalFilter(value)}
          autoScroll={autoScroll}
          onAutoScrollChange={setAutoScroll}
          table={table}
          rowsCount={filteredRecords.length}
          logsLoading={logsLoading}
          onExport={handleExportLogs}
          onRefresh={handleRefreshLogs}
          canRefresh={canRefresh}
        />

        <LogViewerTable
          table={table}
          rows={rows}
          logsLoading={logsLoading}
          tableContainerRef={tableContainerRef}
          visibleColumns={visibleColumns}
        />

        <LogViewerFooter rowsCount={filteredRecords.length} totalRecords={logRecords.length} />
      </CardContent>
    </Card>
  );
}

interface LogViewerToolbarProps {
  logLevelFilter: LogLevel;
  onLevelChange: (value: LogLevel) => void;
  logLevelItems: ReactNode;
  globalFilter: string;
  onSearchChange: (value: string) => void;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  table: ReactTableInstance<LogRecordRow>;
  rowsCount: number;
  logsLoading: boolean;
  onExport: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
}

function LogViewerToolbar({
  logLevelFilter,
  onLevelChange,
  logLevelItems,
  globalFilter,
  onSearchChange,
  autoScroll,
  onAutoScrollChange,
  table,
  rowsCount,
  logsLoading,
  onExport,
  onRefresh,
  canRefresh,
}: LogViewerToolbarProps) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:gap-4">
        <div className="space-y-1">
          <Label htmlFor="log-viewer-level">Minimum Level</Label>
          <Select
            value={logLevelFilter}
            onValueChange={(value) => onLevelChange(value as LogLevel)}
          >
            <SelectTrigger id="log-viewer-level" className="w-[180px]">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>{logLevelItems}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-viewer-search">Search</Label>
          <Input
            id="log-viewer-search"
            placeholder="Scope, message, payload"
            value={globalFilter}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <div className="flex items-center gap-2">
          <Switch
            id="log-viewer-autoscroll"
            checked={autoScroll}
            onCheckedChange={onAutoScrollChange}
          />
          <Label htmlFor="log-viewer-autoscroll">Auto-scroll</Label>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              Columns <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column: Column<LogRecordRow, unknown>) => column.getCanHide())
              .map((column: Column<LogRecordRow, unknown>) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {column.id.charAt(0).toUpperCase() + column.id.slice(1)}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onExport}
            disabled={rowsCount === 0}
          >
            Export
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={logsLoading || !canRefresh}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}

interface LogViewerTableProps {
  table: ReactTableInstance<LogRecordRow>;
  rows: Row<LogRecordRow>[];
  logsLoading: boolean;
  tableContainerRef: MutableRefObject<HTMLDivElement | null>;
  visibleColumns: Column<LogRecordRow, unknown>[];
}

function LogViewerTable({
  table,
  rows,
  logsLoading,
  tableContainerRef,
  visibleColumns,
}: LogViewerTableProps) {
  useEffect(() => {
    if (rows.length === 0) {
      return;
    }
    const container = tableContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [rows.length, tableContainerRef]);

  return (
    <div className="rounded-md border border-border/60">
      <div ref={tableContainerRef} className="relative h-[500px] overflow-auto bg-muted/20">
        {logsLoading && rows.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">Loading logs…</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            No logs recorded for the current session.
          </div>
        ) : (
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <colgroup>
              {visibleColumns.map((column) => (
                <col
                  key={column.id}
                  style={{
                    width: column.getSize() ? `${column.getSize()}px` : undefined,
                  }}
                />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-sm">
              {table.getHeaderGroups().map((headerGroup: HeaderGroup<LogRecordRow>) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header: Header<LogRecordRow, unknown>) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-foreground transition hover:text-primary"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <span>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {{
                            asc: '↑',
                            desc: '↓',
                          }[header.column.getIsSorted() as string] ?? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      ) : (
                        <div className="text-sm font-medium">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </div>
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="align-top">
                  {row.getVisibleCells().map((cell: Cell<LogRecordRow, unknown>) => (
                    <TableCell key={cell.id} className="align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </table>
        )}
      </div>
    </div>
  );
}

interface LogViewerFooterProps {
  rowsCount: number;
  totalRecords: number;
}

function LogViewerFooter({ rowsCount, totalRecords }: LogViewerFooterProps) {
  const start = rowsCount === 0 ? 0 : 1;
  const end = rowsCount;
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <div>
        Showing {start} to {end} of {rowsCount} log{rowsCount === 1 ? '' : 's'}
      </div>
      <div>
        {rowsCount} row{rowsCount === 1 ? '' : 's'} (filtered from {totalRecords} total)
      </div>
    </div>
  );
}

function sortLogRecords(records: readonly LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => a.timestamp - b.timestamp);
}

function formatLogTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch {
    return String(timestamp);
  }
}

function serializeArgs(args?: readonly unknown[]): string {
  if (!args || args.length === 0) {
    return '';
  }
  return args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function getLevelBadgeVariant(level: LogLevel): 'default' | 'secondary' | 'destructive' {
  switch (level) {
    case LogLevel.ERROR:
    case LogLevel.FATAL:
      return 'destructive';
    case LogLevel.TRACE:
    case LogLevel.DEBUG:
      return 'secondary';
    default:
      return 'default';
  }
}
