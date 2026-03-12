import type { QueueAdapter } from '@brainstrike/queue';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Database, MessageCircle } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { AssistantTab } from './assistant-tab';
import { preloadAssistantUiPanelWrapper } from './assistant-ui-panel-wrapper-lazy';
import { DatabaseTab, preloadDatabaseTab } from './database-tab';
import {
  sanitizeToolsPanelTab,
  toolsPanelSelectors,
  useToolsPanelStore,
} from './stores/tools-panel-store';

interface ToolsPanelProps {
  /**
   * CRITICAL: The app-specific embedding queue from RootLayoutContent.
   *
   * This queue flows through: RootLayoutContent → ToolsPanel (HERE) → DatabaseTab
   *
   * MUST be passed through to DatabaseTab! Without it, embedding
   * management and import operations will fail.
   */
  embeddingQueue?: QueueAdapter | null;
  readonly preloadDatabaseTabOnMount?: boolean;
}

/**
 * Tools panel containing Assistant and Database tabs.
 *
 * IMPORTANT: The embeddingQueue prop must be forwarded to DatabaseTab to ensure
 * embedding operations and import work correctly.
 */
export function ToolsPanel({
  embeddingQueue = null,
  preloadDatabaseTabOnMount = false,
}: ToolsPanelProps): ReactElement {
  const activeTab = useToolsPanelStore(toolsPanelSelectors.activeTab);
  const setActiveTab = useToolsPanelStore((state) => state.setActiveTab);
  const [assistantSurfaceReady, setAssistantSurfaceReady] = useState(false);

  useEffect(() => {
    if (!preloadDatabaseTabOnMount) {
      return;
    }
    void preloadDatabaseTab();
  }, [preloadDatabaseTabOnMount]);

  useEffect(() => {
    if (activeTab !== 'assistant') {
      return;
    }

    // Defer the heavy assistant surface until after the shell has committed once.
    // In the built desktop renderer, loading it during the initial mount can stall
    // the lazy boundary indefinitely even though the emitted chunk is present.
    const timeoutId = window.setTimeout(() => {
      setAssistantSurfaceReady(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeTab]);

  useEffect(() => {
    if (!(assistantSurfaceReady && activeTab === 'assistant')) {
      return;
    }
    void preloadAssistantUiPanelWrapper();
  }, [activeTab, assistantSurfaceReady]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={(value) => setActiveTab(sanitizeToolsPanelTab(value))}
        value={activeTab}
      >
        <TabsList className="flex h-9 w-full justify-start rounded-none border-b bg-transparent p-0">
          <TabsTrigger
            aria-label="Assistant"
            className="relative flex h-9 items-center gap-2 rounded-none border-transparent border-b-2 bg-transparent px-4 pt-2 pb-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            value="assistant"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Assistant</span>
          </TabsTrigger>
          <TabsTrigger
            aria-label="Database"
            className="relative flex h-9 items-center gap-2 rounded-none border-transparent border-b-2 bg-transparent px-4 pt-2 pb-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            value="database"
          >
            <Database className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex min-h-0 flex-1 flex-col">
          <TabsContent
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            forceMount
            value="assistant"
          >
            {assistantSurfaceReady ? (
              <AssistantTab />
            ) : (
              <div className="p-4 text-xs opacity-70">Preparing assistant…</div>
            )}
          </TabsContent>

          <TabsContent
            className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden"
            value="database"
          >
            {/* CRITICAL: Pass embeddingQueue to DatabaseTab
                This ensures import operations use the app's embedding queue */}
            <DatabaseTab embeddingQueue={embeddingQueue} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
