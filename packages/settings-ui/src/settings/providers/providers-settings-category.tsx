import { Plug } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { ProvidersSettings, type ProvidersSettingsProps } from './providers-settings';

/**
 * Creates the Provider Hub category (BST-1358) outside the
 * `SettingsPageContent` component module so Fast Refresh can preserve page
 * state when category composition changes.
 *
 * Replaces the former "API Keys" category: credentials, verification and model
 * enablement are one journey and now live on one surface.
 */
export function createProvidersSettingsCategory(options: ProvidersSettingsProps): SettingsCategory {
  return {
    content: <ProvidersSettings {...options} />,
    description: 'Connect model providers, test credentials, and choose which models are enabled.',
    icon: Plug,
    id: 'providers',
    keywords: [
      'providers',
      'api',
      'keys',
      'secrets',
      'credentials',
      'openai',
      'anthropic',
      'google',
      'bedrock',
      'openrouter',
      'models',
      'connect',
    ],
    title: 'Providers',
  };
}
