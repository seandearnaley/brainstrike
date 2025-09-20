import { SettingsPageContent as BaseSettingsPageContent } from '@brainstrike/app-shell';
import { LlmKeysSettings } from './llm-keys';
import { McpConfigStatus } from './mcp-config-status';

export default function SettingsPageContent() {
  const Component = BaseSettingsPageContent as React.ComponentType<{
    children?: React.ReactNode;
  }>;

  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta name="description" content="BrainStrike Desktop Settings" />

      <Component>
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Desktop Preferences</h2>
          <p className="text-sm text-muted-foreground">Manage local desktop-specific settings.</p>
          <LlmKeysSettings />
          <McpConfigStatus />
        </div>
      </Component>
    </>
  );
}
