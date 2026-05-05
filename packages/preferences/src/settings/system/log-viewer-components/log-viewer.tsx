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
import { defaultCollator } from '@brainstrike/utils/collator';
import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';
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
import { useCallback, useEffect, useMemo, useReducer } from 'react';
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
const DEFAULT_RETENTION_LIMIT = 2000;
const DEFAULT_PAGE_SIZE = 50;
const ALL_SCOPES_VALUE = '__all__';
const NO_SCOPE_VALUE = '__none__';

const LOG_LEVEL_ITEMS = LOG_LEVEL_OPTIONS.map((level) => (
  <SelectItem key={level} value={level}>
    {level.charAt(0).toUpperCase() + level.slice(1).toLowerCase()}
  </SelectItem>
));

const RETENTION_ITEMS = RETENTION_OPTIONS.map((limit) => (
  <SelectItem key={limit} value={String(limit)}>
    {limit.toLocaleString()} logs
  </SelectItem>
));

const PAGE_SIZE_ITEMS = PAGE_SIZE_OPTIONS.map((size) => (
  <SelectItem key={size} value={String(size)}>
    {size} rows
  </SelectItem>
));

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

function getLogRecordContext(record: LogRecord): Record<string, unknown> | null {
  for (const arg of record.args.toReversed()) {
    if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) {
      continue;
    }
    return arg as Record<string, unknown>;
  }
  return null;
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

function getRuntimeSource(record: LogRecord): string {
  const context = getLogRecordContext(record);
  const explicitSource = context?.['logSource'];
  if (typeof explicitSource === 'string' && explicitSource.trim().length > 0) {
    return explicitSource.trim();
  }
  const runtime = record.bindings?.['runtime'];
  return typeof runtime === 'string' && runtime.trim().length > 0 ? runtime.trim() : 'unknown';
}

function buildSourceCoverage(records: readonly LogRecord[]): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (const record of records) {
    const source = getRuntimeSource(record);
    coverage[source] = (coverage[source] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(coverage).sort(([left], [right]) => defaultCollator.compare(left, right))
  );
}

function formatSourceCoverage(records: readonly LogRecord[]): string {
  if (records.length === 0) {
    return 'Sources: none';
  }
  return `Sources: ${Object.entries(buildSourceCoverage(records))
    .map(([source, count]) => `${source} ${count.toLocaleString()}`)
    .join(' · ')}`;
}

function buildLogColumns(wrapLines: boolean): ColumnDef<LogRecordRow>[] {
  const messageClassName = wrapLines ? 'line-clamp-2 break-words' : 'truncate';
  const payloadClassName = wrapLines ? 'line-clamp-2 break-all' : 'truncate';
  return [
    {
      accessorKey: 'timestamp',
      cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => (
        <span className="font-mono text-muted-foreground text-xs">
          {formatLogTimestamp(getValue() as number)}
        </span>
      ),
      enableSorting: true,
      header: 'Time',
      size: 110,
    },
    {
      accessorKey: 'level',
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
      header: 'Level',
      size: 84,
    },
    {
      accessorKey: 'scope',
      cell: ({ getValue }: CellContext<LogRecordRow, unknown>) => {
        const scope = getValue() as string | undefined;
        return scope ? (
          <span className="line-clamp-1 font-medium text-primary/80 text-xs">[{scope}]</span>
        ) : (
          <span className="text-muted-foreground/30 text-xs">—</span>
        );
      },
      enableSorting: false,
      header: 'Scope',
      size: 160,
    },
    {
      accessorKey: 'message',
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
      header: 'Message',
      size: 360,
    },
    {
      accessorKey: 'serializedArgs',
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
      header: 'Payload',
      size: 260,
    },
    {
      accessorKey: 'flattenedBindings',
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
      header: 'Bindings',
      size: 220,
    },
  ];
}

interface LogViewerState {
  autoScroll: boolean;
  columnVisibility: VisibilityState;
  globalFilter: string;
  logLevelFilter: LogLevel;
  logRecords: readonly LogRecord[];
  logsLoading: boolean;
  pagination: PaginationState;
  retentionLimit: number;
  scopeFilter: string;
  sorting: SortingState;
  wrapLines: boolean;
}

type LogViewerAction =
  | { type: 'SET_LOG_RECORDS'; records: readonly LogRecord[] }
  | { type: 'SET_LOGS_LOADING'; loading: boolean }
  | { type: 'SET_RETENTION_LIMIT'; limit: number }
  | { type: 'SET_LOG_LEVEL_FILTER'; level: LogLevel }
  | { type: 'SET_SCOPE_FILTER'; scope: string }
  | { type: 'SET_GLOBAL_FILTER'; filter: string }
  | { type: 'SET_AUTO_SCROLL'; value: boolean }
  | { type: 'SET_WRAP_LINES'; value: boolean }
  | { type: 'SET_SORTING'; sorting: SortingState }
  | { type: 'SET_COLUMN_VISIBILITY'; visibility: VisibilityState }
  | {
      type: 'SET_PAGINATION';
      pagination: PaginationState | ((prev: PaginationState) => PaginationState);
    };

const initialLogViewerState: LogViewerState = {
  logRecords: [],
  logsLoading: false,
  retentionLimit: DEFAULT_RETENTION_LIMIT,
  logLevelFilter: LogLevel.DEBUG,
  scopeFilter: ALL_SCOPES_VALUE,
  globalFilter: '',
  autoScroll: true,
  wrapLines: true,
  sorting: [{ id: 'timestamp', desc: false }],
  columnVisibility: {},
  pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
};

function logViewerReducer(state: LogViewerState, action: LogViewerAction): LogViewerState {
  switch (action.type) {
    case 'SET_LOG_RECORDS':
      return { ...state, logRecords: action.records };
    case 'SET_LOGS_LOADING':
      return { ...state, logsLoading: action.loading };
    case 'SET_RETENTION_LIMIT':
      return { ...state, retentionLimit: action.limit };
    case 'SET_LOG_LEVEL_FILTER':
      return { ...state, logLevelFilter: action.level };
    case 'SET_SCOPE_FILTER':
      return { ...state, scopeFilter: action.scope };
    case 'SET_GLOBAL_FILTER':
      return { ...state, globalFilter: action.filter };
    case 'SET_AUTO_SCROLL':
      return { ...state, autoScroll: action.value };
    case 'SET_WRAP_LINES':
      return { ...state, wrapLines: action.value };
    case 'SET_SORTING':
      return { ...state, sorting: action.sorting };
    case 'SET_COLUMN_VISIBILITY':
      return { ...state, columnVisibility: action.visibility };
    case 'SET_PAGINATION': {
      const newPagination =
        typeof action.pagination === 'function'
          ? action.pagination(state.pagination)
          : action.pagination;
      return { ...state, pagination: newPagination };
    }
    default:
      return state;
  }
}

export function LogViewer({ logSource, toast }: LogViewerProps) {
  const [viewerState, dispatch] = useReducer(logViewerReducer, initialLogViewerState);
  const {
    logRecords,
    logsLoading,
    retentionLimit,
    logLevelFilter,
    scopeFilter,
    globalFilter,
    autoScroll,
    wrapLines,
    sorting,
    columnVisibility,
    pagination,
  } = viewerState;

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
      dispatch({ type: 'SET_LOG_RECORDS', records: [] });
      return;
    }
    let cancelled = false;

    if (logSource.getInitialRecords) {
      dispatch({ type: 'SET_LOGS_LOADING', loading: true });
      logSource
        .getInitialRecords()
        .then((initial) => {
          if (!cancelled && initial) {
            dispatch({ type: 'SET_LOG_RECORDS', records: applyRetentionLimit(initial) });
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          toast({
            description: message,
            title: 'Failed to load logs',
            variant: 'destructive',
          });
        })
        .finally(() => {
          if (!cancelled) {
            dispatch({ type: 'SET_LOGS_LOADING', loading: false });
          }
        });
    }

    const unsubscribe = logSource.subscribe?.((records) => {
      dispatch({ type: 'SET_LOG_RECORDS', records: applyRetentionLimit(records) });
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
        flattenedBindings: JSON.stringify(record.bindings ?? {}),
        serializedArgs: serializeArgs(record.args),
      })),
    [filteredRecords]
  );

  const columns = useMemo(() => buildLogColumns(wrapLines), [wrapLines]);

  const sortNewestFirst = sorting[0]?.desc ?? false;
  const lastPageIndex = Math.max(0, Math.ceil(filteredRecords.length / pagination.pageSize) - 1);
  const resolvedPageIndex = autoScroll
    ? sortNewestFirst
      ? 0
      : lastPageIndex
    : Math.min(pagination.pageIndex, lastPageIndex);

  const table = useReactTable({
    columns,
    data: tableData,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onColumnVisibilityChange: (updater) => {
      const newVisibility = typeof updater === 'function' ? updater(columnVisibility) : updater;
      dispatch({ type: 'SET_COLUMN_VISIBILITY', visibility: newVisibility });
    },
    onPaginationChange: (updater) => {
      dispatch({
        type: 'SET_PAGINATION',
        pagination: typeof updater === 'function' ? updater(pagination) : updater,
      });
    },
    onSortingChange: (updater) => {
      const newSorting = typeof updater === 'function' ? updater(sorting) : updater;
      dispatch({ type: 'SET_SORTING', sorting: newSorting });
    },
    state: {
      columnVisibility,
      pagination: {
        pageIndex: resolvedPageIndex,
        pageSize: pagination.pageSize,
      },
      sorting,
    },
  });

  const rows = table.getRowModel().rows;

  const handleRefreshLogs = async () => {
    const getInitialRecords = logSource?.getInitialRecords;
    if (!getInitialRecords) {
      return;
    }
    dispatch({ type: 'SET_LOGS_LOADING', loading: true });
    try {
      const records = await getInitialRecords();
      dispatch({ type: 'SET_LOG_RECORDS', records: applyRetentionLimit(records) });
      dispatch({ type: 'SET_LOGS_LOADING', loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        description: message,
        title: 'Failed to refresh logs',
        variant: 'destructive',
      });
      dispatch({ type: 'SET_LOGS_LOADING', loading: false });
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
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      recordCount: exportData.length,
      sourceCoverage: buildSourceCoverage(exportData),
      records: exportData,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
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
    dispatch({ type: 'SET_SORTING', sorting: [{ desc: value, id: 'timestamp' }] });
  }, []);

  const handlePageSizeChange = useCallback((value: number) => {
    dispatch({
      type: 'SET_PAGINATION',
      pagination: (previous) => ({ ...previous, pageSize: value }),
    });
  }, []);

  const scopeOptions = useMemo(() => {
    const scopes = new Set<string>();
    for (const record of logRecords) {
      if (record.scope) {
        scopes.add(record.scope);
      }
    }
    return Array.from(scopes).sort((a, b) => defaultCollator.compare(a, b));
  }, [logRecords]);

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

  const pageStart = filteredRecords.length === 0 ? 0 : resolvedPageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(filteredRecords.length, (resolvedPageIndex + 1) * pagination.pageSize);
  const sourceCoverageText = formatSourceCoverage(filteredRecords);
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
        logLevelItems={LOG_LEVEL_ITEMS}
        logsLoading={logsLoading}
        onAutoScrollChange={(value) => dispatch({ type: 'SET_AUTO_SCROLL', value })}
        onExport={handleExportLogs}
        onLevelChange={(level) => dispatch({ type: 'SET_LOG_LEVEL_FILTER', level })}
        onPageSizeChange={handlePageSizeChange}
        onRefresh={handleRefreshLogs}
        onRetentionChange={(limit) => dispatch({ type: 'SET_RETENTION_LIMIT', limit })}
        onScopeChange={(scope) => dispatch({ type: 'SET_SCOPE_FILTER', scope })}
        onSearchChange={(filter) => dispatch({ type: 'SET_GLOBAL_FILTER', filter })}
        onSortNewestFirstChange={handleSortNewestFirstChange}
        onWrapLinesChange={(value) => dispatch({ type: 'SET_WRAP_LINES', value })}
        pageSize={pagination.pageSize}
        pageSizeItems={PAGE_SIZE_ITEMS}
        retentionItems={RETENTION_ITEMS}
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
        <span className="flex items-center gap-3">
          <span data-testid="log-viewer-source-coverage">{sourceCoverageText}</span>
          <span>{autoScroll ? 'Auto-scroll on' : 'Scroll paused'}</span>
        </span>
      </div>
      {totalPages > 1 ? (
        <TablePagination
          currentPage={resolvedPageIndex}
          onPageChange={(page) => {
            dispatch({ type: 'SET_AUTO_SCROLL', value: false });
            dispatch({
              type: 'SET_PAGINATION',
              pagination: (previous) => ({ ...previous, pageIndex: page }),
            });
          }}
          totalItems={filteredRecords.length}
          totalPages={totalPages}
        />
      ) : null}
    </Card>
  );
}
