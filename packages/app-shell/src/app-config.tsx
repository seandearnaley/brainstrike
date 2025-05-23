import type { AppShellConfig } from './types';

export function createAppConfig(config: Partial<AppShellConfig>): AppShellConfig {
  return {
    title: 'BrainStrike.ai',
    description: 'Multi-app dashboard',
    themeStorageKey: 'app-theme',
    navigationItems: [],
    ...config,
  };
}
