import type { AppShellConfig } from './types';

export function createAppConfig(config: Partial<AppShellConfig>): AppShellConfig {
  return {
    description: 'Multi-app dashboard',
    navigationItems: [],
    title: 'BrainStrike.ai',
    ...config,
  };
}
