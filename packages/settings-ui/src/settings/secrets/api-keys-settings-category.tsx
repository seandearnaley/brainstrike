import { Key } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { ApiKeysSettings, type ApiKeysSettingsProps } from './api-keys-settings';

/**
 * Creates the desktop API-key settings category outside the
 * `SettingsPageContent` component module so Fast Refresh can preserve page
 * state when category composition changes.
 */
export function createApiKeysSettingsCategory(
  options: ApiKeysSettingsProps = {}
): SettingsCategory {
  return {
    content: <ApiKeysSettings {...options} />,
    description: 'Manage API keys for external LLM providers.',
    icon: Key,
    id: 'api-keys',
    keywords: ['api', 'keys', 'secrets', 'credentials', 'openai', 'anthropic', 'google'],
    title: 'API Keys',
  };
}
