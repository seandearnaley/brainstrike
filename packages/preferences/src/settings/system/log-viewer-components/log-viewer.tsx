import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SelectItem,
  TablePagination,
  type useToast,
} from '@brainstrike/ui';
import { LogLevel, type LogRecord } from '@brainstrike/utils';
import {
  type CellContext,
  type ColumnDef,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';
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

const RETENTION_OPTIONS = [200, 500, 1000, 2000, 5000] as const;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const DEFAULT_RETENTION_LIMIT = 500;
const DEFAULT_PAGE_SIZE = 50;
const ALL_SCOPES_VALUE = '__all__';
const NO_SCOPE_VALUE = '__none__';

function matchesLogLevel(record: LogRecord, minimumLevelIndex: number): boolean {
  const recordLevelIndex = Math.max(0, LOG_LEVEL_OPTIONS.indexOf(record.level));
  return recordLevelIndex >= minimumLevelIndex;
}

function matchesScopeSelection(record: LogRecord, scopeSelection: string): boolean {
  if (!scopeSelection || scopeSelection === ALL_SCOPES_VALUE) {
    return true;
  }
  if (scopeSelection === NO_SCOPE_VALUE) {
    return !(record.scope && record.scope.length > 0);
  }
  return record.scope === scopeSelection;
}

function matchesSearchTerm(record: LogRecord, term: string): boolean {
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
}

function shouldIncludeLogRecord(
  record: LogRecord,
  minimumLevelIndex: number,
  term: string,
  scopeSelection: string
): boolean {
  return (
    matchesLogLevel(record, minimumLevelIndex) &&
    matchesScopeSelection(record, scopeSelection) &&
    matchesSearchTerm(record, term)
  );
}

export function LogViewer({ logSource, toast }: LogViewerProps) {
  const [logRecords, setLogRecords] = useState<readonly LogRecord[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [retentionLimit, setRetentionLimit] = useState<number>(DEFAULT_RETENTION_LIMIT);
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevel>(LogLevel.DEBUG);
  const [scopeFilter, setScopeFilter] = useState<string>(ALL_SCOPES_VALUE);
  const [globalFilter, setGlobalFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'timestamp', desc: false }]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const applyRetentionLimit = useCallback(
    (records: readonly LogRecord[]): LogRecord[] => {
      const sortedRecords = sortLogRecords(records);
      if (retentionLimit <= 0 || sortedRecords.length <= retentionLimit) {
        return sortedRecords;
      }
      return sortedRecords.slice(sortedRecords.length - retentionLimit);
    },
    [retentionLimit]
  );

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
            setLogRecords(applyRetentionLimit(initial));
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
      setLogRecords(applyRetentionLimit(records));
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyRetentionLimit, logSource, toast]);

  const filteredRecords = useMemo(() => {
    const levelIndex = Math.max(0, LOG_LEVEL_OPTIONS.indexOf(logLevelFilter));
    const term = globalFilter.trim().toLowerCase();
    const scopeSelection = scopeFilter.trim();
    return logRecords.filter((record) =>
      shouldIncludeLogRecord(record, levelIndex, term, scopeSelection)
    );
  }, [globalFilter, logLevelFilter, logRecords, scopeFilter]);

  const tableData = useMemo<LogRecordRow[]>(
    () =>
      filteredRecords.map((record) => ({
        ...record,
        serializedArgs: serializeArgs(record.args),
        flattenedBindings: JSON.stringify(record.bindings ?? {}),
      })),
    [filteredRecords]
  );

  const columns = useMemo<ColumnDef<LogRecordRow>[]>(() => {
    const messageClassName = wrapLines ? 'line-clamp-2 break-words' : 'truncate';
    const payloadClassName = wrapLines ? 'line-clamp-2 break-all' : 'truncate';
    return [
      {
        accessorKey: 'timestamp',
        header: 'Time',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => (
          <span className="font-mono text-muted-foreground text-xs">
            {formatLogTimestamp(getValue() as number)}
          </span>
        ),
        enableSorting: true,
        size: 110,
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
              className="h-5 px-1.5 py-0 font-bold text-[10px] uppercase tracking-wider"
              variant={getLevelBadgeVariant(level)}
            >
              {level}
            </Badge>
          );
        },
        enableSorting: false,
        size: 84,
      },
      {
        accessorKey: 'scope',
        header: 'Scope',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const scope = getValue() as string | undefined;
          return scope ? (
            <span className="line-clamp-1 font-medium text-primary/80 text-xs">[{scope}]</span>
          ) : (
            <span className="text-muted-foreground/30 text-xs">—</span>
          );
        },
        enableSorting: false,
        size: 160,
      },
      {
        accessorKey: 'message',
        header: 'Message',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const message = getValue() as string | undefined;
          return (
            <div
              className={`${messageClassName} font-medium text-foreground/90 text-xs`}
              title={message ?? ''}
            >
              {message || <span className="text-muted-foreground/30">—</span>}
            </div>
          );
        },
        enableSorting: false,
        size: 360,
      },
      {
        accessorKey: 'serializedArgs',
        header: 'Payload',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const payload = getValue() as string;
          return payload ? (
            <code
              className={`block rounded border border-border/20 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ${payloadClassName}`}
              title={payload}
            >
              {payload}
            </code>
          ) : (
            <span className="text-muted-foreground/30 text-xs">—</span>
          );
        },
        enableSorting: false,
        size: 260,
      },
      {
        accessorKey: 'flattenedBindings',
        header: 'Bindings',
        cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
          const bindings = getValue() as string;
          const parsed = bindings && bindings !== '{}' ? bindings : null;
          return parsed ? (
            <code
              className={`block rounded border border-border/20 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ${payloadClassName}`}
              title={parsed}
            >
              {parsed}
            </code>
          ) : (
            <span className="text-muted-foreground/30 text-xs">—</span>
          );
        },
        enableSorting: false,
        size: 220,
      },
    ];
  }, [wrapLines]);

  const sortNewestFirst = sorting[0]?.desc ?? false;
  const lastPageIndex = Math.max(0, Math.ceil(filteredRecords.length / pagination.pageSize) - 1);
  const resolvedPageIndex = autoScroll
    ? sortNewestFirst
      ? 0
      : lastPageIndex
    : Math.min(pagination.pageIndex, lastPageIndex);

  const table = useReactTable({
    data: tableData,
    columns,
    state: {
      columnVisibility,
      pagination: {
        pageIndex: resolvedPageIndex,
        pageSize: pagination.pageSize,
      },
      sorting,
    },
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const rows = table.getRowModel().rows;

  const handleRefreshLogs = async () => {
    if (!logSource?.getInitialRecords) {
      return;
    }
    setLogsLoading(true);
    try {
      const records = await logSource.getInitialRecords();
      setLogRecords(applyRetentionLimit(records));
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

  const handleSortNewestFirstChange = useCallback((value: boolean) => {
    setSorting([{ id: 'timestamp', desc: value }]);
  }, []);

  const handlePageSizeChange = useCallback((value: number) => {
    setPagination((previous) => ({
      ...previous,
      pageSize: value,
    }));
  }, []);

  const scopeOptions = useMemo(() => {
    const scopes = new Set<string>();
    for (const record of logRecords) {
      if (record.scope) {
        scopes.add(record.scope);
      }
    }
    return Array.from(scopes).sort((a, b) => a.localeCompare(b));
  }, [logRecords]);

  const logLevelItems = useMemo(
    () =>
      LOG_LEVEL_OPTIONS.map((level) => (
        <SelectItem key={level} value={level}>
          {level.charAt(0).toUpperCase() + level.slice(1).toLowerCase()}
        </SelectItem>
      )),
    []
  );

  const scopeItems = useMemo(
    () => (
      <>
        <SelectItem value={ALL_SCOPES_VALUE}>All scopes</SelectItem>
        <SelectItem value={NO_SCOPE_VALUE}>No scope</SelectItem>
        {scopeOptions.map((scope) => (
          <SelectItem key={scope} value={scope}>
            {scope}
          </SelectItem>
        ))}
      </>
    ),
    [scopeOptions]
  );

  const retentionItems = useMemo(
    () =>
      RETENTION_OPTIONS.map((limit) => (
        <SelectItem key={limit} value={String(limit)}>
          {limit.toLocaleString()} logs
        </SelectItem>
      )),
    []
  );

  const pageSizeItems = useMemo(
    () =>
      PAGE_SIZE_OPTIONS.map((size) => (
        <SelectItem key={size} value={String(size)}>
          {size} rows
        </SelectItem>
      )),
    []
  );

  const pageStart = filteredRecords.length === 0 ? 0 : resolvedPageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(filteredRecords.length, (resolvedPageIndex + 1) * pagination.pageSize);
  const summaryText =
    filteredRecords.length === 0
      ? 'No logs to display.'
      : `Showing ${pageStart}-${pageEnd} of ${filteredRecords.length} logs (retention ${retentionLimit.toLocaleString()}).`;
  const totalPages = Math.max(1, table.getPageCount());

  if (!logSource) {
    return null;
  }

  return (
    <Card className="flex h-[600px] flex-col overflow-hidden border-border/60 shadow-sm transition-all duration-300 hover:shadow-md">
      <CardHeader className="border-border/40 border-b bg-muted/10 pb-3">
        <CardTitle className="font-semibold text-lg tracking-tight">Log Viewer</CardTitle>
        <CardDescription className="text-xs">
          Real-time application logs and diagnostics.
        </CardDescription>
      </CardHeader>

      <LogToolbar
        autoScroll={autoScroll}
        canRefresh={Boolean(logSource.getInitialRecords)}
        globalFilter={globalFilter}
        logLevelFilter={logLevelFilter}
        logLevelItems={logLevelItems}
        logsLoading={logsLoading}
        onAutoScrollChange={setAutoScroll}
        onExport={handleExportLogs}
        onLevelChange={setLogLevelFilter}
        onPageSizeChange={handlePageSizeChange}
        onRefresh={handleRefreshLogs}
        onRetentionChange={setRetentionLimit}
        onScopeChange={setScopeFilter}
        onSearchChange={setGlobalFilter}
        onSortNewestFirstChange={handleSortNewestFirstChange}
        onWrapLinesChange={setWrapLines}
        pageSize={pagination.pageSize}
        pageSizeItems={pageSizeItems}
        retentionItems={retentionItems}
        retentionLimit={retentionLimit}
        rowsCount={filteredRecords.length}
        scopeFilter={scopeFilter}
        scopeItems={scopeItems}
        sortNewestFirst={sortNewestFirst}
        table={table}
        wrapLines={wrapLines}
      />

      <CardContent className="relative flex flex-1 flex-col overflow-hidden p-0">
        <LogList
          autoScroll={autoScroll}
          autoScrollAnchor={sortNewestFirst ? 'start' : 'end'}
          logsLoading={logsLoading}
          rows={rows}
          table={table}
          wrapLines={wrapLines}
        />
        <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-6 bg-gradient-to-t from-background to-transparent opacity-50" />
      </CardContent>

      <div className="flex items-center justify-between border-border/40 border-t bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground">
        <span data-testid="log-viewer-summary">{summaryText}</span>
        <span>{autoScroll ? 'Auto-scroll on' : 'Scroll paused'}</span>
      </div>
      {totalPages > 1 ? (
        <TablePagination
          currentPage={resolvedPageIndex}
          onPageChange={(page) => {
            setAutoScroll(false);
            setPagination((previous) => ({ ...previous, pageIndex: page }));
          }}
          totalItems={filteredRecords.length}
          totalPages={totalPages}
        />
      ) : null}
    </Card>
  );
}
