import { describe, it, expect } from 'vitest';
import baseConfig from '../tailwind.config';

describe('tailwind configuration', () => {
  it('exports without throwing', () => {
    expect(baseConfig).toBeDefined();
  });

  it('contains expected fields', () => {
    expect(baseConfig.darkMode).toEqual(['class']);
    expect(baseConfig.safelist).toContain('bg-primary');
    expect(Array.isArray(baseConfig.plugins)).toBe(true);
  });

  it('merges with additional configuration', () => {
    const plugin = () => {};
    const merged = {
      ...baseConfig,
      theme: {
        ...baseConfig.theme,
        extend: {
          ...(baseConfig.theme?.extend ?? {}),
          colors: {
            ...(baseConfig.theme?.extend?.colors ?? {}),
            brand: '#fff',
          },
        },
      },
      plugins: [...(baseConfig.plugins ?? []), plugin],
    };

    expect(merged.theme.extend.colors.brand).toBe('#fff');
    expect(merged.theme.extend.colors.primary.DEFAULT).toBe(
      'hsl(var(--primary))'
    );
    expect(merged.plugins).toContain(plugin);
  });
});
