import {
  createAppearanceSettingsCategory,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/app-shell';
import { Key, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { LlmKeysSettings } from './llm-keys';
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

export default function SettingsPageContent() {
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      {
        id: 'desktop-preferences',
        title: 'Desktop Preferences',
        description: 'Configure local storage and encrypted secrets for the desktop app.',
        keywords: ['desktop', 'preferences', 'api keys', 'llm', 'encryption', 'credentials'],
        icon: Key,
        render: () => <DesktopPreferencesCategory />,
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
