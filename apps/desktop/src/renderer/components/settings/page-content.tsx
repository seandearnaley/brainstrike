import { QueueHud, VectorStatusWithDialog } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { Badge } from '@brainstrike/ui';
import { Cpu, FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { DesktopLoggingSettings } from './logging-settings';
import { McpConfigStatus } from './mcp-config-status';
import { McpToolsPanel } from './mcp-tools-panel';

function McpIntegrationsCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Model Context Protocol</h3>
        <p className="text-sm text-muted-foreground">
          Inspect the current MCP configuration, change the config file, and manage discovered
          tools.
        </p>
      </div>
      <McpConfigStatus />
      <McpToolsPanel />
    </div>
  );
}

function EmbeddingModelsCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">Models & Providers</h3>
        <p className="text-sm text-muted-foreground">
          Manage AI providers and enable/disable specific models for chat and embeddings.
        </p>
      </div>
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

export default function SettingsPageContent() {
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'embedding-models',
        title: 'Models & Providers',
        description: 'Enable embedding providers and choose the active model.',
        keywords: ['embeddings', 'models', 'providers', 'vector'],
        icon: Layers,
        render: () => <EmbeddingModelsCategory />,
      },
      {
        id: 'embedding-worker',
        title: 'Embedding Worker',
        description: 'Check queue throughput and vector status for desktop embeddings.',
        keywords: ['embeddings', 'worker', 'queue', 'vector', 'database'],
        icon: Cpu,
        render: () => <EmbeddingWorkerCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control renderer log verbosity and manage file logging for debugging.',
        keywords: ['logging', 'diagnostics', 'debugging', 'log file'],
        icon: FileCog,
        render: () => <DesktopLoggingSettings />,
      },
      {
        id: 'mcp-integrations',
        title: 'MCP Integrations',
        description: 'Manage Model Context Protocol servers, tools, and connection paths.',
        keywords: ['mcp', 'tools', 'servers', 'integration', 'protocol'],
        icon: Layers,
        render: () => <McpIntegrationsCategory />,
      },
      createFactoryResetSettingsCategory(),
    ],
    []
  );

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta name="description" content="BrainStrike Desktop Settings" />

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
