import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell';
import { useFileExplorerStore } from '@brainstrike/file-explorer';
import {
  createApiKeysSettingsCategory,
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { DesktopLoggingSettings } from './logging-settings';
import { McpConfigStatus } from './mcp-config-status';
import { McpToolsPanel } from './mcp-tools-panel';

function McpIntegrationsCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="font-semibold text-lg">Model Context Protocol</h3>
        <p className="text-muted-foreground text-sm">
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
  return <ModelSelectionPage />;
}

export default function SettingsPageContent() {
  // Inline fixture state from file explorer store (developer feature)
  const devInlineFixtureEnabled = useFileExplorerStore((s) => s.devInlineFixtureEnabled);
  const setDevInlineFixtureEnabled = useFileExplorerStore((s) => s.setDevInlineFixtureEnabled);

  // Inline fixture is available on desktop (uses createFixtureCapableAdapter)
  // TODO: Should this be gated by dev mode? For now, always available on desktop.
  const inlineFixtureAvailable = true;

  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      createApiKeysSettingsCategory(),
      {
        id: 'embedding-models',
        title: 'Models & Providers',
        description: 'Choose chat and embedding models, manage downloads, and configure providers.',
        keywords: ['embeddings', 'models', 'providers', 'vector', 'llm', 'download'],
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
      createSystemDiagnosticsSettingsCategory(),
      createFactoryResetSettingsCategory({
        isWebPlatform: false,
        inlineFixtureSetting: inlineFixtureAvailable
          ? {
              available: true,
              loading: false,
              checked: devInlineFixtureEnabled,
              onChange: setDevInlineFixtureEnabled,
            }
          : undefined,
      }),
    ],
    [devInlineFixtureEnabled, setDevInlineFixtureEnabled]
  );

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta content="BrainStrike Desktop Settings" name="description" />

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
