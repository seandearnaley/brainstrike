import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Brain, Database, FileText, MessageCircle, Search } from 'lucide-react';
import React, { lazy, useEffect, useState } from 'react';
import { EmbeddingsPanel } from './embeddings-panel';
import { isDbUiEnabled } from './env';
import { McpBanner } from './mcp-banner';
import { type DbSubtab, dbPanelSelectors, useDbPanelStore } from './stores/db-panel-store';
import {
  type RightPanelTab,
  rightPanelSelectors,
  useRightPanelStore,
} from './stores/right-panel-store';
import { searchPanelSelectors, useSearchPanelStore } from './stores/search-panel-store';

// Database UI is behind a build flag to avoid bundling DB/WASM in renderer when disabled
const ENABLE_DB_UI: boolean = isDbUiEnabled();
let DatabaseTab: React.ComponentType | null = null;
if (ENABLE_DB_UI) {
  DatabaseTab = lazy(() =>
    import('./database-tab-chunk').then((m) => ({ default: m.DatabaseTab }))
  );
}

const AssistantUiPanelLazy = lazy(async () => ({
  default: (await import('@brainstrike/ui/assistant-ui-panel')).AssistantUiPanel,
}));

export function RightPanel() {
  const activeTab = useRightPanelStore(rightPanelSelectors.activeTab);
  const setActiveTab = useRightPanelStore((s) => s.setActiveTab);
  // Unconditional hooks for DB logs controls (selector tuples to keep shape stable)
  const filterText = useDbPanelStore(dbPanelSelectors.filter);
  const [dbSortBy, dbSortDir] = useDbPanelStore(dbPanelSelectors.sorting);
  const [dbPage, dbPageSize] = useDbPanelStore(dbPanelSelectors.paging);
  const setDbFilterText = useDbPanelStore((s) => s.setFilterText);
  const setDbSort = useDbPanelStore((s) => s.setSort);
  const setDbPage = useDbPanelStore((s) => s.setPage);
  const setDbPageSize = useDbPanelStore((s) => s.setPageSize);
  const activeSubtab = useDbPanelStore(dbPanelSelectors.activeSubtab);
  const setActiveSubtab = useDbPanelStore((s) => s.setActiveSubtab);

  // Search panel filters as stable tuple + actions
  const [query, regex, caseSensitive, wholeWord] = useSearchPanelStore(
    searchPanelSelectors.queryAndFlags
  );
  const setQuery = useSearchPanelStore((s) => s.setQuery);
  const toggleRegex = useSearchPanelStore((s) => s.toggleRegex);
  const toggleCaseSensitive = useSearchPanelStore((s) => s.toggleCaseSensitive);
  const toggleWholeWord = useSearchPanelStore((s) => s.toggleWholeWord);
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab((v as RightPanelTab) ?? 'properties')}
        className="flex-1 flex flex-col"
      >
        <TabsList className="grid grid-cols-5 mx-2 mt-2 mb-2 flex-shrink-0">
          <TabsTrigger value="properties" className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            <span className="hidden sm:inline">Props</span>
          </TabsTrigger>
          <TabsTrigger value="assistant" className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" />
            <span className="hidden sm:inline">Assistant</span>
          </TabsTrigger>
          <TabsTrigger value="embeddings" className="flex items-center gap-1">
            <Brain className="h-3 w-3" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger value="search" className="flex items-center gap-1">
            <Search className="h-3 w-3" />
            <span className="hidden sm:inline">Search</span>
          </TabsTrigger>
          <TabsTrigger value="database" className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 px-2 pb-2 flex flex-col min-h-0">
          <TabsContent value="properties" className="flex-1 mt-0 min-h-0">
            <div className="flex h-full flex-col overflow-hidden">
              <PropertiesInspectorCard />
            </div>
          </TabsContent>

          <TabsContent value="assistant" className="flex-1 mt-0 min-h-0">
            {activeTab === 'assistant' ? (
              <div className="flex h-full flex-col overflow-hidden">
                <AssistantChatCard />
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="embeddings" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <EmbeddingsPanel />
          </TabsContent>

          <TabsContent value="search" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Search</CardTitle>
                <CardDescription className="text-xs">
                  Search and replace functionality
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                {/* Persisted search form */}
                <div className="grid grid-cols-1 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="rp-search-query">
                      Query
                    </Label>
                    <Input
                      id="rp-search-query"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className="text-xs"
                      placeholder="Search..."
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={regex}
                        onChange={toggleRegex}
                      />
                      <span>Regex</span>
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={caseSensitive}
                        onChange={toggleCaseSensitive}
                      />
                      <span>Case</span>
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={wholeWord}
                        onChange={toggleWholeWord}
                      />
                      <span>Whole word</span>
                    </label>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-0 min-h-0 flex flex-col gap-2">
            <div className="flex items-center gap-2 px-2">
              <Label className="text-[11px]">View</Label>
              <select
                className="h-7 text-[11px] border rounded px-1"
                aria-label="DB subtab"
                value={activeSubtab}
                onChange={(e) => setActiveSubtab(e.target.value as DbSubtab)}
              >
                <option value="overview">Overview</option>
                <option value="logs">Logs</option>
                <option value="config">Config</option>
              </select>
            </div>
            {activeSubtab === 'overview' &&
              (DatabaseTab ? (
                <React.Suspense
                  fallback={<div className="text-xs opacity-70 px-2">Loading DB UI…</div>}
                >
                  <DatabaseTab />
                </React.Suspense>
              ) : (
                <div className="text-xs opacity-70 px-2">Database UI disabled in this build.</div>
              ))}
            {activeSubtab === 'logs' && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Logs</CardTitle>
                  <CardDescription className="text-xs">
                    Recent database/queue events
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]" htmlFor="db-logs-filter">
                        Filter
                      </Label>
                      <Input
                        id="db-logs-filter"
                        className="h-7 text-[11px]"
                        value={filterText}
                        onChange={(e) => setDbFilterText(e.target.value)}
                        placeholder="e.g., embeddings"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]" htmlFor="db-logs-sortby">
                        Sort By
                      </Label>
                      <Input
                        id="db-logs-sortby"
                        className="h-7 text-[11px]"
                        value={dbSortBy ?? ''}
                        onChange={(e) => setDbSort(e.target.value || null, dbSortDir)}
                        placeholder="column name"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]" htmlFor="db-logs-dir">
                        Direction
                      </Label>
                      <select
                        id="db-logs-dir"
                        className="h-7 text-[11px] border rounded px-1"
                        value={dbSortDir}
                        onChange={(e) =>
                          setDbSort(dbSortBy ?? null, e.target.value as 'asc' | 'desc')
                        }
                      >
                        <option value="asc">asc</option>
                        <option value="desc">desc</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]" htmlFor="db-logs-page">
                        Page
                      </Label>
                      <Input
                        id="db-logs-page"
                        type="number"
                        className="h-7 text-[11px]"
                        value={dbPage}
                        onChange={(e) => setDbPage(Number(e.target.value) || 1)}
                        min={1}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]" htmlFor="db-logs-pagesize">
                        Page Size
                      </Label>
                      <Input
                        id="db-logs-pagesize"
                        type="number"
                        className="h-7 text-[11px]"
                        value={dbPageSize}
                        onChange={(e) => setDbPageSize(Number(e.target.value) || 10)}
                        min={1}
                      />
                    </div>
                  </div>
                  <div>Database is initializing...</div>
                </CardContent>
              </Card>
            )}
            {activeSubtab === 'config' && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Config</CardTitle>
                  <CardDescription className="text-xs">Connection and tuning</CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Database is initializing...
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

type AssistantAvailabilityState =
  | { state: 'loading' }
  | { state: 'enabled' }
  | { state: 'disabled'; reason?: string }
  | { state: 'error'; message: string };

function PropertiesInspectorCard() {
  const { fileContents } = useFileExplorer();
  const { selectedFilePaths } = useSelectionManager({ onSelectionLimitExceeded: () => {} });
  const info = buildSelectionInfo(Array.from(selectedFilePaths ?? []), fileContents ?? {});

  return (
    <Card className="flex-shrink-0" data-testid="properties-inspector">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Properties</CardTitle>
        <CardDescription className="text-xs">Element properties and attributes</CardDescription>
      </CardHeader>
      <CardContent className="text-xs space-y-3">
        <SelectionDetails info={info} />
        <McpBanner />
      </CardContent>
    </Card>
  );
}

type SelectionInfo =
  | { kind: 'empty' }
  | {
      kind: 'selected';
      path: string;
      additionalCount: number;
      preview?: { text: string; truncated: boolean };
    };

function buildSelectionInfo(
  selectedPaths: string[],
  fileContents: Record<string, unknown>
): SelectionInfo {
  if (selectedPaths.length === 0) {
    return { kind: 'empty' };
  }

  const activeIndex = selectedPaths.length - 1;
  if (activeIndex < 0) {
    return { kind: 'empty' };
  }
  const activePath = selectedPaths[activeIndex];
  if (!activePath) {
    return { kind: 'empty' };
  }
  const rawValue = fileContents[activePath];
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : undefined;

  if (!trimmed) {
    return {
      kind: 'selected',
      path: activePath,
      additionalCount: Math.max(0, selectedPaths.length - 1),
    };
  }

  const snippet = trimmed.slice(0, 400);
  return {
    kind: 'selected',
    path: activePath,
    additionalCount: Math.max(0, selectedPaths.length - 1),
    preview: { text: snippet, truncated: trimmed.length > snippet.length },
  };
}

function SelectionDetails({ info }: { info: SelectionInfo }) {
  if (info.kind === 'empty') {
    return (
      <div className="rounded border border-dashed p-3 text-[11px] text-muted-foreground">
        Select a component or file to inspect its properties.
      </div>
    );
  }

  const additionalSummary =
    info.additionalCount > 0
      ? `+${info.additionalCount} additional ${info.additionalCount === 1 ? 'item' : 'items'} selected`
      : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-[11px] uppercase tracking-wide text-muted-foreground">
          Selected
        </span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{info.path}</code>
      </div>
      {additionalSummary ? (
        <div className="text-[11px] text-muted-foreground">{additionalSummary}</div>
      ) : null}
      {info.preview ? (
        <div>
          <span className="font-medium text-[11px] uppercase tracking-wide text-muted-foreground">
            Preview
          </span>
          <pre className="max-h-40 overflow-auto rounded border border-dashed bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {info.preview.text}
            {info.preview.truncated ? '…' : ''}
          </pre>
        </div>
      ) : (
        <div className="rounded border border-dashed p-3 text-[11px] text-muted-foreground">
          No cached preview available for this selection. Choose an element in the editor to inspect
          its props.
        </div>
      )}
    </div>
  );
}

function AssistantChatCard() {
  const status = useAssistantAvailability();

  return (
    <Card
      className="flex min-h-[320px] flex-1 flex-col overflow-hidden"
      data-testid="assistant-chat-card"
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Assistant</CardTitle>
        <CardDescription className="text-xs">
          Chat with the Brainstrike assistant for guidance while editing props.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        {status.state === 'loading' && (
          <div className="p-4 text-xs opacity-70">Checking assistant availability…</div>
        )}
        {status.state === 'error' && (
          <div className="p-4">
            <AssistantStatusCallout
              title="Assistant unavailable"
              description="Could not determine assistant status."
              detail={status.message}
              variant="error"
            />
          </div>
        )}
        {status.state === 'disabled' && (
          <div className="p-4">
            <AssistantStatusCallout
              title="Assistant disabled"
              description="Add an OpenAI API key in Settings → LLM Provider Keys to enable the assistant."
              variant="warning"
              {...(status.reason ? { detail: `Reason: ${status.reason}` } : {})}
            />
          </div>
        )}
        {status.state === 'enabled' && (
          <React.Suspense
            fallback={<div className="p-4 text-xs opacity-70">Loading assistant…</div>}
          >
            <AssistantUiPanelLazy className="flex h-full min-h-0 flex-col" />
          </React.Suspense>
        )}
      </CardContent>
    </Card>
  );
}

function useAssistantAvailability(): AssistantAvailabilityState {
  const [state, setState] = useState<AssistantAvailabilityState>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetchAssistantStatusState(controller.signal)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error) => {
        if (cancelled) return;
        if ((error as { name?: string })?.name === 'AbortError') return;
        setState({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return state;
}

async function resolveAssistantStatusUrl(): Promise<string> {
  if (typeof window === 'undefined') return '/api/assistant/status';

  type AssistantBridge = {
    url?: string;
    getUrl?: () => Promise<string>;
  };

  const assistantBridge = (window as unknown as { assistant?: AssistantBridge }).assistant;

  if (assistantBridge) {
    if (typeof assistantBridge.getUrl === 'function') {
      try {
        const base = await assistantBridge.getUrl();
        if (base) {
          return `${trimTrailingSlash(base)}/assistant/status`;
        }
      } catch {}
    }

    if (typeof assistantBridge.url === 'string' && assistantBridge.url.length > 0) {
      return `${trimTrailingSlash(assistantBridge.url)}/assistant/status`;
    }
  }

  return '/api/assistant/status';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function fetchAssistantStatusState(signal: AbortSignal): Promise<AssistantAvailabilityState> {
  const url = await resolveAssistantStatusUrl();
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`status ${res.status}`);
  }
  const payload = (await res.json()) as { enabled: boolean; reason?: string };
  if (payload.enabled) {
    return { state: 'enabled' };
  }
  if (payload.reason) {
    return { state: 'disabled', reason: payload.reason };
  }
  return { state: 'disabled' };
}

function AssistantStatusCallout({
  title,
  description,
  detail,
  variant,
}: {
  title: string;
  description: string;
  detail?: string;
  variant: 'warning' | 'error';
}) {
  const tone =
    variant === 'error'
      ? 'border-destructive/50 text-destructive'
      : 'border-muted-foreground/40 text-muted-foreground';
  return (
    <div
      className={`rounded-md border border-dashed p-3 text-xs leading-relaxed ${tone}`}
      data-testid="assistant-status-callout"
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1">{description}</div>
      {detail ? <div className="mt-1 text-[11px] opacity-80">{detail}</div> : null}
    </div>
  );
}
