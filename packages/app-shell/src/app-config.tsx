import type { AppShellConfig } from './types';

export function createAppConfig(config: Partial<AppShellConfig>): AppShellConfig {
  return {
    description: 'Multi-app dashboard',
    navigationItems: [],
    themeStorageKey: 'app-theme',
    title: 'BrainStrike.ai',
    ...config,
  };
}
