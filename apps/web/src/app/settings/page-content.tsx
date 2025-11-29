import { QueueHud, VectorStatusWithDialog } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  LoggingSettingsSection,
  type LogSourceAdapter,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { Badge } from '@brainstrike/ui';
import { Cpu, FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { getWebLogBuffer } from '../../log-buffer';

function ModelSelectionCategory() {
  return (
    <div className="space-y-4">
      <ModelSelectionPage />
    </div>
  );
}

function EmbeddingWorkerCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          Embedding Worker
          <Badge variant="secondary">experimental</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">
          Monitor the embedding job queue and inspect vector store connectivity without leaving the
          settings screen.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QueueHud />
        <VectorStatusWithDialog />
      </div>
    </div>
  );
}

// Factory Reset category provided via createFactoryResetSettingsCategory()

export default function SettingsPageContent() {
  const logSource = useMemo<LogSourceAdapter>(() => {
    const buffer = getWebLogBuffer();
    return {
      getInitialRecords: async () => buffer.getRecords(),
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'models',
        title: 'Models & Providers',
        description: 'Manage AI providers and enable/disable specific models.',
        keywords: ['models', 'providers', 'llm', 'embedding', 'vector'],
        icon: Layers,
        render: () => <ModelSelectionCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        render: () => <LoggingSettingsSection runtime="browser" logSource={logSource} />,
      },
      {
        id: 'embedding-worker',
        title: 'Embedding Worker',
        description: 'Check queue throughput and vector status for in-browser embeddings.',
        keywords: ['embeddings', 'worker', 'queue', 'vector', 'database'],
        icon: Cpu,
        render: () => <EmbeddingWorkerCategory />,
      },
      createFactoryResetSettingsCategory(),
    ],
    [logSource]
  );

  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta name="description" content="Customize your application settings" />
      </Helmet>

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
