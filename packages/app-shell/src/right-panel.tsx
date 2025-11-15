import type { QueueAdapter } from '@brainstrike/queue';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { Brain, Database, MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import { AssistantTab } from './assistant-tab';
import { DatabaseTab } from './database-tab';
import { EmbeddingsTab } from './embeddings-tab';
import {
  type RightPanelTab,
  rightPanelSelectors,
  useRightPanelStore,
} from './stores/right-panel-store';

interface RightPanelProps {
  /**
   * CRITICAL: The app-specific embedding queue from RootLayoutContent.
   *
   * This queue flows through: RootLayoutContent → RightPanel (HERE) → DatabaseTab → VectorStatusWithDialog
   *
   * MUST be passed through to DatabaseTab! Without it, embedding operations will fail.
   */
  embeddingQueue?: QueueAdapter | null;
}

/**
 * Right panel containing Assistant, Embeddings, and Database tabs.
 *
 * IMPORTANT: The embeddingQueue prop must be forwarded to DatabaseTab to ensure
 * the manage embedding sets button and embedding operations work correctly.
 */
export function RightPanel({ embeddingQueue = null }: RightPanelProps): ReactElement {
  const activeTab = useRightPanelStore(rightPanelSelectors.activeTab);
  const setActiveTab = useRightPanelStore((state) => state.setActiveTab);

  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab((value as RightPanelTab) ?? 'assistant')}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="grid grid-cols-3 mx-2 mt-2 mb-2 flex-shrink-0">
          <TabsTrigger value="assistant" className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" />
            <span className="hidden sm:inline">Assistant</span>
          </TabsTrigger>
          <TabsTrigger value="embeddings" className="flex items-center gap-1">
            <Brain className="h-3 w-3" />
            <span className="hidden sm:inline">Embed</span>
          </TabsTrigger>
          <TabsTrigger value="database" className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            <span className="hidden sm:inline">DB</span>
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 px-2 flex flex-col min-h-0">
          <TabsContent
            value="assistant"
            forceMount
            className="flex-1 min-h-0 data-[state=inactive]:hidden flex flex-col"
          >
            <AssistantTab />
          </TabsContent>

          <TabsContent value="embeddings" className="flex-1 mt-0 overflow-y-auto min-h-0">
            <EmbeddingsTab />
          </TabsContent>

          <TabsContent value="database" className="flex-1 mt-0 overflow-y-auto min-h-0">
            {/* CRITICAL: Pass embeddingQueue to DatabaseTab
                This ensures VectorStatusWithDialog gets the app's embedding queue */}
            <DatabaseTab embeddingQueue={embeddingQueue} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
