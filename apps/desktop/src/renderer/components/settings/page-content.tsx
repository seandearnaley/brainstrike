import { STANDARD_EMBEDDING_DIMENSION } from '@brainstrike/embeddings';
import {
  createAppearanceSettingsCategory,
  createTokenCountingSettingsCategory,
  EmbeddingSettings,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { FileCog, Key, Layers } from 'lucide-react';
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
          <span className="text-xs font-normal text-muted-foreground">
            {STANDARD_EMBEDDING_DIMENSION}D baseline
          </span>
        </h3>
        <p className="text-sm text-muted-foreground">
          Enable hosted providers, manage local embeddings, and pick the default model used by the
          desktop importer.
        </p>
      </div>
      <EmbeddingSettings />
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
