import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SelectItem,
  type useToast,
} from '@brainstrike/ui';
import { LogLevel, type LogRecord } from '@brainstrike/utils';
import {
  type CellContext,
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { useEffect, useMemo, useState } from 'react';
import { LogList } from './log-list';
import { LogToolbar } from './log-toolbar';
import {
  formatLogTimestamp,
  getLevelBadgeVariant,
  type LogRecordRow,
  serializeArgs,
  sortLogRecords,
} from './log-utils';

export interface LogSourceAdapter {
  getInitialRecords?: () => Promise<readonly LogRecord[]>;
  subscribe?: (handler: (records: readonly LogRecord[]) => void) => () => void;
}

interface LogViewerProps {
  logSource: LogSourceAdapter | undefined;
  toast: ReturnType<typeof useToast>['toast'];
}

const LOG_LEVEL_OPTIONS: LogLevel[] = [
  LogLevel.TRACE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
  LogLevel.SILENT,
];

export function LogViewer({ logSource, toast }: LogViewerProps) {
  const [logRecords, setLogRecords] = useState<readonly LogRecord[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel>(LogLevel.DEBUG);
  const [globalFilter, setGlobalFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  // Pagination state is kept for API compatibility but we are using virtualization for the main view.
  // However, if we want to support "export all" or similar, we might need it.
  // For now, let's keep the table model simple and just show all rows via virtualization.
  // We can set page size to a very large number or just not use pagination model for the view.
  // But wait, the previous implementation used getPaginationRowModel.
  // If we want to render *all* rows in a virtual list, we should probably NOT use pagination model for the view,
  // OR set the page size to Infinity.
  // Let's stick to showing everything in one long scrollable list as requested ("render a lot of rows").
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10000, // Large default for virtualization
  });

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
        header: 'Time',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => (
          <span className="text-xs text-muted-foreground font-mono">
            {formatLogTimestamp(getValue() as number)}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: 'level',
        header: 'Level',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const rawLevel = getValue();
          const level =
            typeof rawLevel === 'string' && LOG_LEVEL_OPTIONS.includes(rawLevel as LogLevel)
              ? (rawLevel as LogLevel)
              : LogLevel.INFO;
          return (
            <Badge
              variant={getLevelBadgeVariant(level)}
              className="text-[10px] px-1.5 py-0 h-5 uppercase tracking-wider font-bold"
            >
              {level}
            </Badge>
          );
        },
        size: 80,
      },
      {
        accessorKey: 'scope',
        header: 'Scope',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const scope = getValue() as string | undefined;
          return scope ? (
            <span className="text-xs font-medium text-primary/80">[{scope}]</span>
          ) : (
            <span className="text-xs text-muted-foreground/30">—</span>
          );
        },
        size: 140,
      },
      {
        accessorKey: 'message',
        header: 'Message',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const message = getValue() as string | undefined;
          return (
            <div className="truncate text-xs text-foreground/90 font-medium" title={message ?? ''}>
              {message || <span className="text-muted-foreground/30">—</span>}
            </div>
          );
        },
        size: 350,
      },
      {
        accessorKey: 'serializedArgs',
        header: 'Payload',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const payload = getValue() as string;
          return payload ? (
            <code
              className="block max-w-xs truncate text-[10px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded border border-border/20 font-mono"
              title={payload}
            >
              {payload}
            </code>
          ) : (
            <span className="text-xs text-muted-foreground/30">—</span>
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
            <code
              className="block max-w-xs truncate text-[10px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded border border-border/20 font-mono"
              title={parsed}
            >
              {parsed}
            </code>
          ) : (
            <span className="text-xs text-muted-foreground/30">—</span>
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
      pagination,
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: 'includesString',
    initialState: {
      sorting: [{ id: 'timestamp', desc: true }],
    },
  });

  const rows = table.getRowModel().rows;

  const handleRefreshLogs = async () => {
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
  };

  const handleExportLogs = () => {
    if (typeof window === 'undefined') {
      return;
    }
    const exportRows = table.getPrePaginationRowModel().rows;
    if (exportRows.length === 0) {
      return;
    }
    const exportData = exportRows.map((row) => row.original);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `brainstrike-logs-${new Date().toISOString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const logLevelItems = useMemo(
    () =>
      LOG_LEVEL_OPTIONS.map((level) => (
        <SelectItem key={level} value={level}>
          {level.charAt(0).toUpperCase() + level.slice(1).toLowerCase()}
        </SelectItem>
      )),
    []
  );

  if (!logSource) {
    return null;
  }

  return (
    <Card className="flex flex-col overflow-hidden border-border/60 shadow-sm h-[600px] transition-all duration-300 hover:shadow-md">
      <CardHeader className="pb-3 border-b border-border/40 bg-muted/10">
        <CardTitle className="text-lg font-semibold tracking-tight">Log Viewer</CardTitle>
        <CardDescription className="text-xs">
          Real-time application logs and diagnostics.
        </CardDescription>
      </CardHeader>

      <LogToolbar
        logLevelFilter={logLevelFilter}
        onLevelChange={setLogLevelFilter}
        logLevelItems={logLevelItems}
        globalFilter={globalFilter}
        onSearchChange={setGlobalFilter}
        autoScroll={autoScroll}
        onAutoScrollChange={setAutoScroll}
        table={table}
        rowsCount={filteredRecords.length}
        logsLoading={logsLoading}
        onExport={handleExportLogs}
        onRefresh={handleRefreshLogs}
        canRefresh={Boolean(logSource.getInitialRecords)}
      />

      <CardContent className="flex-1 p-0 overflow-hidden flex flex-col relative">
        <LogList table={table} rows={rows} logsLoading={logsLoading} autoScroll={autoScroll} />
        <div className="absolute bottom-0 right-0 left-0 h-6 bg-gradient-to-t from-background to-transparent pointer-events-none opacity-50" />
      </CardContent>

      <div className="px-4 py-2 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground flex justify-between items-center">
        <span>
          Total: {logRecords.length} | Filtered: {filteredRecords.length}
        </span>
        <span>{autoScroll ? 'Auto-scroll active' : 'Scroll paused'}</span>
      </div>
    </Card>
  );
}
