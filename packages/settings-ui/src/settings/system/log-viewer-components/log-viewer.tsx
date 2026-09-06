import { LogLevel, type LogRecord } from '@brainstrike/logging';
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
import {
  type CellContext,
  type ColumnDef,
  type ColumnVisibilityState,
  type PaginationState,
  type SortingState,
  useTable,
} from '@tanstack/react-table';
import { useCallback, useMemo, useReducer, useState } from 'react';
import {
  ALL_CODES_VALUE,
  ALL_SOURCES_VALUE,
  LogDiagnosticFilters,
  NO_CODE_VALUE,
} from './log-diagnostic-filters';
import { getLogRecordCode, getLogRecordSource } from './log-diagnostic-metadata';
import { LogList } from './log-list';
import { LogRecordDetailDialog, LogRowActions } from './log-record-detail-dialog';
import type { LogSourceAdapter } from './log-source-adapter';
import { type LogTableFeatures, logTableFeatures } from './log-table-features';
import { LogToolbar } from './log-toolbar';
import {
  createLogSearchHaystackCache,
  formatLogTimestamp,
  getCachedLogSearchHaystack,
  getLevelBadgeVariant,
  type LogRecordRow,
  type LogSearchHaystackCache,
  serializeArgs,
  serializeBindings,
  sortLogRecords,
} from './log-utils';
import { useLogExport } from './use-log-export';
import { useLogRecordSource } from './use-log-record-source';

interface LogViewerProps {
  emptyStateText?: string;
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

function getLogLevelIndex(level: LogLevel): number {
  const knownLevelIndex = LOG_LEVEL_OPTIONS.indexOf(level);
  return knownLevelIndex === -1 ? LOG_LEVEL_OPTIONS.indexOf(LogLevel.INFO) : knownLevelIndex;
}

function matchesLogLevel(record: LogRecord, minimumLevelIndex: number): boolean {
  return getLogLevelIndex(record.level) >= minimumLevelIndex;
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

function getLogRecordRow(
  record: LogRecord,
  rowCache: WeakMap<LogRecord, LogRecordRow>
): LogRecordRow {
  const cachedRow = rowCache.get(record);
  if (cachedRow) {
    return cachedRow;
  }
  const row: LogRecordRow = {
    ...record,
    flattenedBindings: serializeBindings(record.bindings),
    originalRecord: record,
    serializedArgs: serializeArgs(record.args),
  };
  rowCache.set(record, row);
  return row;
}

function matchesSearchTerm(
  record: LogRecord,
  term: string,
  rowCache: WeakMap<LogRecord, LogRecordRow>,
  searchHaystackCache: LogSearchHaystackCache
): boolean {
  if (!term) {
    return true;
  }
  const row = getLogRecordRow(record, rowCache);
  const haystack = getCachedLogSearchHaystack(row, searchHaystackCache);
  return haystack.includes(term);
}

function shouldIncludeLogRecord(
  record: LogRecord,
  minimumLevelIndex: number,
  term: string,
  scopeSelection: string,
  sourceSelection: string,
  codeSelection: string,
  timeStart: number | null,
  timeEnd: number | null,
  rowCache: WeakMap<LogRecord, LogRecordRow>,
  searchHaystackCache: LogSearchHaystackCache
): boolean {
  if (!matchesLogLevel(record, minimumLevelIndex)) {
    return false;
  }
  if (!matchesScopeSelection(record, scopeSelection)) {
    return false;
  }
  if (sourceSelection !== ALL_SOURCES_VALUE && getLogRecordSource(record) !== sourceSelection) {
    return false;
  }
  if (codeSelection !== ALL_CODES_VALUE) {
    const code = getLogRecordCode(record);
    if (codeSelection === NO_CODE_VALUE ? code !== null : code !== codeSelection) {
      return false;
    }
  }
  if (timeStart !== null && record.timestamp < timeStart) {
    return false;
  }
  if (timeEnd !== null && record.timestamp > timeEnd) {
    return false;
  }
  return matchesSearchTerm(record, term, rowCache, searchHaystackCache);
}

function getRuntimeSource(record: LogRecord): string {
  return getLogRecordSource(record);
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

function buildLogColumns(
  wrapLines: boolean,
  onShowDetails: (record: LogRecord) => void
): ColumnDef<LogTableFeatures, LogRecordRow>[] {
  const messageClassName = wrapLines ? 'line-clamp-2 break-words' : 'truncate';
  const payloadClassName = wrapLines ? 'line-clamp-2 break-all' : 'truncate';
  return [
    {
      accessorKey: 'timestamp',
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => (
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
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => {
        const rawLevel = getValue();
        const knownLevel =
          typeof rawLevel === 'string' && LOG_LEVEL_OPTIONS.includes(rawLevel as LogLevel)
            ? (rawLevel as LogLevel)
            : null;
        return (
          <Badge
            className="h-5 px-1.5 py-0 font-bold text-[10px] uppercase tracking-wider"
            variant={knownLevel ? getLevelBadgeVariant(knownLevel) : 'outline'}
          >
            {knownLevel ?? `unknown (${String(rawLevel)})`}
          </Badge>
        );
      },
      enableSorting: false,
      header: 'Level',
      size: 84,
    },
    {
      accessorKey: 'scope',
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => {
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
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => {
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
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => {
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
      cell: ({ getValue }: CellContext<LogTableFeatures, LogRecordRow, unknown>) => {
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
    {
      cell: ({ row }) => (
        <LogRowActions onShowDetails={onShowDetails} record={row.original.originalRecord} />
      ),
      enableHiding: false,
      enableSorting: false,
      header: 'Actions',
      id: 'actions',
      size: 180,
    },
  ];
}

interface LogViewerState {
  autoScroll: boolean;
  codeFilter: string;
  columnVisibility: ColumnVisibilityState;
  globalFilter: string;
  logLevelFilter: LogLevel;
  logRecords: readonly LogRecord[];
  logsLoading: boolean;
  pagination: PaginationState;
  retentionLimit: number;
  scopeFilter: string;
  sorting: SortingState;
  sourceFilter: string;
  subscriptionError: string | null;
  timeEnd: number | null;
  timeStart: number | null;
  wrapLines: boolean;
}

type LogViewerAction =
  | { type: 'SET_LOG_RECORDS'; records: readonly LogRecord[] }
  | { type: 'SET_LOGS_LOADING'; loading: boolean }
  | { type: 'SET_RETENTION_LIMIT'; limit: number }
  | { type: 'SET_LOG_LEVEL_FILTER'; level: LogLevel }
  | { type: 'SET_SCOPE_FILTER'; scope: string }
  | { type: 'SET_SOURCE_FILTER'; source: string }
  | { type: 'SET_SUBSCRIPTION_ERROR'; error: string | null }
  | { type: 'SET_CODE_FILTER'; code: string }
  | { type: 'SET_TIME_START'; value: number | null }
  | { type: 'SET_TIME_END'; value: number | null }
  | { type: 'SET_GLOBAL_FILTER'; filter: string }
  | { type: 'SET_AUTO_SCROLL'; value: boolean }
  | { type: 'SET_WRAP_LINES'; value: boolean }
  | { type: 'SET_SORTING'; sorting: SortingState }
  | { type: 'SET_COLUMN_VISIBILITY'; visibility: ColumnVisibilityState }
  | {
      type: 'SET_PAGINATION';
      pagination: PaginationState | ((prev: PaginationState) => PaginationState);
    };

const initialLogViewerState: LogViewerState = {
  autoScroll: true,
  codeFilter: ALL_CODES_VALUE,
  columnVisibility: {},
  globalFilter: '',
  logLevelFilter: LogLevel.DEBUG,
  logRecords: [],
  logsLoading: false,
  pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
  retentionLimit: DEFAULT_RETENTION_LIMIT,
  scopeFilter: ALL_SCOPES_VALUE,
  sorting: [{ desc: false, id: 'timestamp' }],
  sourceFilter: ALL_SOURCES_VALUE,
  subscriptionError: null,
  timeEnd: null,
  timeStart: null,
  wrapLines: true,
};

function logViewerReducer(state: LogViewerState, action: LogViewerAction): LogViewerState {
  switch (action.type) {
    case 'SET_LOG_RECORDS': {
      const sourceFilter =
        state.sourceFilter === ALL_SOURCES_VALUE ||
        action.records.some((record) => getLogRecordSource(record) === state.sourceFilter)
          ? state.sourceFilter
          : ALL_SOURCES_VALUE;
      const codeFilter =
        state.codeFilter === ALL_CODES_VALUE ||
        state.codeFilter === NO_CODE_VALUE ||
        action.records.some((record) => getLogRecordCode(record) === state.codeFilter)
          ? state.codeFilter
          : ALL_CODES_VALUE;
      return { ...state, codeFilter, logRecords: action.records, sourceFilter };
    }
    case 'SET_LOGS_LOADING':
      return { ...state, logsLoading: action.loading };
    case 'SET_RETENTION_LIMIT':
      return { ...state, retentionLimit: action.limit };
    case 'SET_LOG_LEVEL_FILTER':
      return { ...state, logLevelFilter: action.level };
    case 'SET_SCOPE_FILTER':
      return { ...state, scopeFilter: action.scope };
    case 'SET_SOURCE_FILTER':
      return { ...state, sourceFilter: action.source };
    case 'SET_SUBSCRIPTION_ERROR':
      return { ...state, subscriptionError: action.error };
    case 'SET_CODE_FILTER':
      return { ...state, codeFilter: action.code };
    case 'SET_TIME_START':
      return { ...state, timeStart: action.value };
    case 'SET_TIME_END':
      return { ...state, timeEnd: action.value };
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

export function LogViewer({ logSource, toast, emptyStateText }: LogViewerProps) {
  const [viewerState, dispatch] = useReducer(logViewerReducer, initialLogViewerState);
  const [selectedRecord, setSelectedRecord] = useState<LogRecord | null>(null);
  const [rowCache] = useState(() => new WeakMap<LogRecord, LogRecordRow>());
  const [searchHaystackCache] = useState(createLogSearchHaystackCache);
  const {
    logRecords,
    logsLoading,
    retentionLimit,
    logLevelFilter,
    scopeFilter,
    sourceFilter,
    codeFilter,
    timeStart,
    timeEnd,
    globalFilter,
    autoScroll,
    wrapLines,
    sorting,
    columnVisibility,
    pagination,
    subscriptionError,
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
  const onRecordsChange = useCallback((records: readonly LogRecord[]) => {
    dispatch({ records, type: 'SET_LOG_RECORDS' });
  }, []);
  const onLoadingChange = useCallback((loading: boolean) => {
    dispatch({ loading, type: 'SET_LOGS_LOADING' });
  }, []);
  const onSubscriptionErrorChange = useCallback((error: string | null) => {
    dispatch({ error, type: 'SET_SUBSCRIPTION_ERROR' });
  }, []);
  const { refreshLogs } = useLogRecordSource({
    applyRetentionLimit,
    logSource,
    onLoadingChange,
    onRecordsChange,
    onSubscriptionErrorChange,
    toast,
  });

  const filteredRecords = useMemo(() => {
    const levelIndex = getLogLevelIndex(logLevelFilter);
    const term = globalFilter.trim().toLowerCase();
    const scopeSelection = scopeFilter.trim();
    searchHaystackCache.resetFor(logRecords);
    return logRecords.filter((record) =>
      shouldIncludeLogRecord(
        record,
        levelIndex,
        term,
        scopeSelection,
        sourceFilter,
        codeFilter,
        timeStart,
        timeEnd,
        rowCache,
        searchHaystackCache
      )
    );
  }, [
    codeFilter,
    globalFilter,
    logLevelFilter,
    logRecords,
    rowCache,
    scopeFilter,
    sourceFilter,
    timeEnd,
    searchHaystackCache,
    timeStart,
  ]);

  const tableData = useMemo<LogRecordRow[]>(
    () => filteredRecords.map((record) => getLogRecordRow(record, rowCache)),
    [filteredRecords, rowCache]
  );

  const handleShowDetails = useCallback((record: LogRecord) => {
    setSelectedRecord(record);
  }, []);
  const columns = useMemo(
    () => buildLogColumns(wrapLines, handleShowDetails),
    [handleShowDetails, wrapLines]
  );

  const sortNewestFirst = sorting[0]?.desc ?? false;
  const lastPageIndex = Math.max(0, Math.ceil(filteredRecords.length / pagination.pageSize) - 1);
  const resolvedPageIndex = autoScroll
    ? sortNewestFirst
      ? 0
      : lastPageIndex
    : Math.min(pagination.pageIndex, lastPageIndex);

  const table = useTable({
    columns,
    data: tableData,
    features: logTableFeatures,
    onColumnVisibilityChange: (updater) => {
      const newVisibility = typeof updater === 'function' ? updater(columnVisibility) : updater;
      dispatch({ type: 'SET_COLUMN_VISIBILITY', visibility: newVisibility });
    },
    onPaginationChange: (updater) => {
      dispatch({
        pagination: typeof updater === 'function' ? updater(pagination) : updater,
        type: 'SET_PAGINATION',
      });
    },
    onSortingChange: (updater) => {
      const newSorting = typeof updater === 'function' ? updater(sorting) : updater;
      dispatch({ sorting: newSorting, type: 'SET_SORTING' });
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

  const getExportRecords = useCallback(
    () => table.getPrePaginatedRowModel().rows.map((row) => row.original.originalRecord),
    [table]
  );
  const handleExportLogs = useLogExport({
    getExportRecords,
    sourceCoverage: buildSourceCoverage,
    toast,
  });

  const handleSortNewestFirstChange = useCallback((value: boolean) => {
    dispatch({ sorting: [{ desc: value, id: 'timestamp' }], type: 'SET_SORTING' });
  }, []);

  const handlePageSizeChange = useCallback((value: number) => {
    dispatch({
      pagination: (previous) => ({ ...previous, pageSize: value }),
      type: 'SET_PAGINATION',
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
    <>
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
          diagnosticFilters={
            <LogDiagnosticFilters
              codeFilter={codeFilter}
              onCodeChange={(code) => dispatch({ code, type: 'SET_CODE_FILTER' })}
              onSourceChange={(source) => dispatch({ source, type: 'SET_SOURCE_FILTER' })}
              onTimeEndChange={(value) => dispatch({ type: 'SET_TIME_END', value })}
              onTimeStartChange={(value) => dispatch({ type: 'SET_TIME_START', value })}
              records={logRecords}
              sourceFilter={sourceFilter}
              timeEnd={timeEnd}
              timeStart={timeStart}
            />
          }
          globalFilter={globalFilter}
          logLevelFilter={logLevelFilter}
          logLevelItems={LOG_LEVEL_ITEMS}
          logsLoading={logsLoading}
          onAutoScrollChange={(value) => dispatch({ type: 'SET_AUTO_SCROLL', value })}
          onExport={handleExportLogs}
          onLevelChange={(level) => dispatch({ level, type: 'SET_LOG_LEVEL_FILTER' })}
          onPageSizeChange={handlePageSizeChange}
          onRefresh={refreshLogs}
          onRetentionChange={(limit) => dispatch({ limit, type: 'SET_RETENTION_LIMIT' })}
          onScopeChange={(scope) => dispatch({ scope, type: 'SET_SCOPE_FILTER' })}
          onSearchChange={(filter) => dispatch({ filter, type: 'SET_GLOBAL_FILTER' })}
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
            {...(emptyStateText === undefined ? {} : { emptyStateText })}
          />
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-6 bg-gradient-to-t from-background to-transparent opacity-50" />
        </CardContent>

        <div className="flex items-center justify-between border-border/40 border-t bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground">
          <span data-testid="log-viewer-summary">{summaryText}</span>
          <span className="flex items-center gap-3">
            <span data-testid="log-viewer-source-coverage">{sourceCoverageText}</span>
            <span data-testid="log-viewer-live-status" role="status">
              {subscriptionError
                ? `Live updates unavailable: ${subscriptionError}`
                : autoScroll
                  ? 'Auto-scroll on'
                  : 'Scroll paused'}
            </span>
          </span>
        </div>
        {totalPages > 1 ? (
          <TablePagination
            currentPage={resolvedPageIndex}
            onPageChange={(page) => {
              dispatch({ type: 'SET_AUTO_SCROLL', value: false });
              dispatch({
                pagination: (previous) => ({ ...previous, pageIndex: page }),
                type: 'SET_PAGINATION',
              });
            }}
            totalItems={filteredRecords.length}
            totalPages={totalPages}
          />
        ) : null}
      </Card>
      <LogRecordDetailDialog onClose={() => setSelectedRecord(null)} record={selectedRecord} />
    </>
  );
}
