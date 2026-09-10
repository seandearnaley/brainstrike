import { describe, expect, test } from 'vitest';
import { createAppConfig } from '../app-config';

describe('createAppConfig', () => {
  test('returns default config when no parameters provided', () => {
    const config = createAppConfig({});

    expect(config.title).toBe('BrainStrike.ai');
    expect(config.description).toBe('Multi-app dashboard');
    expect(config.themeStorageKey).toBe('app-theme');
    expect(config.themePaletteStorageKey).toBe('app-theme-palette');
    expect(config.navigationItems).toEqual([]);
  });

  test('merges provided config with defaults', () => {
    const customConfig = {
      navigationItems: [{ icon: () => null, name: 'Test', path: '/test' }],
      title: 'Custom App',
    };

    const config = createAppConfig(customConfig);

    expect(config.title).toBe('Custom App');
    expect(config.description).toBe('Multi-app dashboard'); // default
    expect(config.navigationItems).toEqual(customConfig.navigationItems);
  });
});
