import type { QueueAdapter } from '@brainstrike/queue';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Brain, Database, Layers, MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { AssistantTab } from './assistant-tab';
import { DatabaseTab } from './database-tab';
import { EmbeddingsTab } from './embeddings-tab';
import {
  type RightPanelTab,
  rightPanelSelectors,
  useRightPanelStore,
} from './stores/right-panel-store';
import { VectorsTab } from './vectors-tab';

type RightPanelProps = {
  /**
   * CRITICAL: The app-specific embedding queue from RootLayoutContent.
   *
   * This queue flows through: RootLayoutContent → RightPanel (HERE) → VectorsTab → VectorStatusWithDialog
   *
   * MUST be passed through to VectorsTab and DatabaseTab! Without it, embedding
   * management and import operations will fail.
   */
  embeddingQueue?: QueueAdapter | null;
};

/**
 * Right panel containing Assistant, Embeddings, Vectors, and Database tabs.
 *
 * IMPORTANT: The embeddingQueue prop must be forwarded to VectorsTab to ensure
 * the manage embedding sets button and embedding operations work correctly.
 */
export function RightPanel({ embeddingQueue = null }: RightPanelProps): ReactElement {
  const activeTab = useRightPanelStore(rightPanelSelectors.activeTab);
  const setActiveTab = useRightPanelStore((state) => state.setActiveTab);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        className="flex min-h-0 flex-1 flex-col"
        onValueChange={(value) => setActiveTab((value as RightPanelTab) ?? 'assistant')}
        value={activeTab}
      >
        <TabsList className="mx-2 mt-2 mb-2 grid flex-shrink-0 grid-cols-4">
          <TabsTrigger className="flex items-center gap-1" value="assistant">
            <MessageCircle className="h-3 w-3" />
            <span className="hidden sm:inline">Assistant</span>
          </TabsTrigger>
          <TabsTrigger className="flex items-center gap-1" value="embeddings">
            <Brain className="h-3 w-3" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger className="flex items-center gap-1" value="vectors">
            <Layers className="h-3 w-3" />
            <span className="hidden sm:inline">Vectors</span>
          </TabsTrigger>
          <TabsTrigger className="flex items-center gap-1" value="database">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex min-h-0 flex-1 flex-col px-2">
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
