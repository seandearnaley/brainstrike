import { QueueHud, VectorStatusWithDialog } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createTokenCountingSettingsCategory,
  EmbeddingSettings,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { Badge } from '@brainstrike/ui';
import { Cpu, FileCog, Key, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { LlmKeysSettings } from './llm-keys';
import { DesktopLoggingSettings } from './logging-settings';
import { McpConfigStatus } from './mcp-config-status';
import { McpToolsPanel } from './mcp-tools-panel';

function DesktopPreferencesCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Secure Provider Credentials</h3>
        <p className="text-sm text-muted-foreground">
          Store API keys in the encrypted desktop keychain for OpenAI, Anthropic, Google, and more.
        </p>
      </div>
      <LlmKeysSettings />
    </div>
  );
}

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

export default function SettingsPageContent() {
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'desktop-preferences',
        title: 'Desktop Preferences',
        description: 'Configure local storage and encrypted secrets for the desktop app.',
        keywords: ['desktop', 'preferences', 'api keys', 'llm', 'encryption', 'credentials'],
        icon: Key,
        render: () => <DesktopPreferencesCategory />,
      },
      {
        id: 'embedding-models',
        title: 'Embedding Models',
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
