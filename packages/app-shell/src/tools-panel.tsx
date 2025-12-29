import type { QueueAdapter } from '@brainstrike/queue';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Brain, Database, Layers, MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { AssistantTab } from './assistant-tab';
import { DatabaseTab } from './database-tab';
import { EmbeddingsTab } from './embeddings-tab';
import {
  type ToolsPanelTab,
  toolsPanelSelectors,
  useToolsPanelStore,
} from './stores/tools-panel-store';
import { VectorsTab } from './vectors-tab';

type ToolsPanelProps = {
  /**
   * CRITICAL: The app-specific embedding queue from RootLayoutContent.
   *
   * This queue flows through: RootLayoutContent → ToolsPanel (HERE) → VectorsTab → VectorStatusWithDialog
   *
   * MUST be passed through to VectorsTab and DatabaseTab! Without it, embedding
   * management and import operations will fail.
   */
  embeddingQueue?: QueueAdapter | null;
};

/**
 * Tools panel containing Assistant, Embeddings, Vectors, and Database tabs.
 *
 * IMPORTANT: The embeddingQueue prop must be forwarded to VectorsTab to ensure
 * the manage embedding sets button and embedding operations work correctly.
 */
export function ToolsPanel({ embeddingQueue = null }: ToolsPanelProps): ReactElement {
  const activeTab = useToolsPanelStore(toolsPanelSelectors.activeTab);
  const setActiveTab = useToolsPanelStore((state) => state.setActiveTab);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={(value) => setActiveTab((value as ToolsPanelTab) ?? 'assistant')}
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
            aria-label="Embeddings"
            className="relative flex h-9 items-center gap-2 rounded-none border-transparent border-b-2 bg-transparent px-4 pt-2 pb-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            value="embeddings"
          >
            <Brain className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger
            aria-label="Vectors"
            className="relative flex h-9 items-center gap-2 rounded-none border-transparent border-b-2 bg-transparent px-4 pt-2 pb-2 font-medium text-muted-foreground shadow-none transition-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            value="vectors"
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Vectors</span>
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
            <AssistantTab />
          </TabsContent>

          <TabsContent className="mt-0 min-h-0 flex-1 overflow-y-auto" value="embeddings">
            <EmbeddingsTab />
          </TabsContent>

          <TabsContent className="mt-0 min-h-0 flex-1 overflow-y-auto" value="vectors">
            {/* CRITICAL: Pass embeddingQueue to VectorsTab
                This ensures VectorStatusWithDialog gets the app's embedding queue */}
            <VectorsTab embeddingQueue={embeddingQueue} />
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
