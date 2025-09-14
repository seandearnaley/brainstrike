import type {
  AgentMessage,
  CancellableIterable,
  ChatTransport,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/ui';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChatPanel,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { Brain, Database, FileText, Search } from 'lucide-react';
import { DatabaseDemoPanel } from './database-demo-panel';
import { EmbeddingsPanel } from './embeddings-panel';
import { QueueHud } from './queue-hud';
import { type DbSubtab, dbPanelSelectors, useDbPanelStore } from './stores/db-panel-store';
import {
  type RightPanelTab,
  rightPanelSelectors,
  useRightPanelStore,
} from './stores/right-panel-store';
import { searchPanelSelectors, useSearchPanelStore } from './stores/search-panel-store';
import { VectorStatusWithDb } from './vector-status';

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
        <TabsList className="grid grid-cols-4 mx-2 mt-2 mb-2 flex-shrink-0">
          <TabsTrigger value="properties" className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            <span className="hidden sm:inline">Props</span>
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
          <TabsContent value="properties" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Properties</CardTitle>
                <CardDescription className="text-xs">
                  Element properties and attributes
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                <ChatPanel
                  {...(desktopTransport
                    ? {
                        transport: desktopTransport,
                        runtime: { mcpEnabled: true },
                      }
                    : {})}
                />
                <div>
                  <h4 className="font-medium mb-2">Basic Properties</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                    incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
                    nostrud exercitation ullamco laboris.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Advanced Settings</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu
                    fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in
                    culpa qui officia deserunt mollit anim id est laborum.
                  </p>
                </div>
              </CardContent>
            </Card>
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

                {/* Existing descriptive content */}
                <div>
                  <h4 className="font-medium mb-2">Search Options</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur,
                    adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et
                    dolore magnam aliquam quaerat voluptatem.
                  </p>
                </div>
                <div>
                  <h4 className="font-medium mb-2">Replace Functions</h4>
                  <p className="text-muted-foreground leading-relaxed">
                    Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit
                    laboriosam, nisi ut aliquid ex ea commodi consequatur.
                  </p>
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
            {activeSubtab === 'overview' && (
              <>
                <DatabaseDemoPanel />
                <VectorStatusWithDb />
                <QueueHud />
              </>
            )}
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
// Desktop override: if window.agent.chat exists, provide a transport that
// calls the local agent via IPC and pseudo-streams the returned chunks.
const desktopTransport: ChatTransport | undefined = window?.agent?.chat
  ? async (messages: AgentMessage[], runtime?: RuntimeData) => {
      let stopped = false;
      try {
        const chat = window.agent?.chat;
        if (!chat) throw new Error('Agent chat not available');
        const chunks = (await chat(messages, runtime)) as StreamChunk[];
        const gen = (async function* (): AsyncGenerator<StreamChunk> {
          for (const c of chunks) {
            if (stopped) break;
            yield c;
            // Yield microtask to keep UI responsive
            // eslint-disable-next-line no-await-in-loop
            await Promise.resolve();
          }
        })();
        const cancellableGen = gen as CancellableIterable<StreamChunk>;
        cancellableGen.cancel = () => {
          stopped = true;
        };
        return cancellableGen;
      } catch (err) {
        console.warn('Desktop transport failed:', err);
        // Return empty iterator on failure
        const empty = (async function* (): AsyncGenerator<StreamChunk> {})();
        const cancellableEmpty = empty as CancellableIterable<StreamChunk>;
        cancellableEmpty.cancel = () => {
          stopped = true;
        };
        return cancellableEmpty;
      }
    }
  : undefined;
