import { QueueHud, VectorStatusWithDialog } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  EmbeddingSettings,
  LoggingSettingsSection,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { Badge } from '@brainstrike/ui';
import { Cpu, FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';

function EmbeddingModelsCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          Embedding Models
          <Badge variant="outline">256-1536D</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">
          Manage which embedding providers are available and choose the active model used for
          imports, vector search, and assistant memory.
        </p>
      </div>
      <EmbeddingSettings />
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
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'embedding-models',
        title: 'Embedding Models',
        description: 'Enable providers and pick the default embedding model.',
        keywords: ['embeddings', 'models', 'providers', 'vector'],
        icon: Layers,
        render: () => <EmbeddingModelsCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        render: () => <LoggingSettingsSection runtime="browser" />,
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
    []
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
