import { describe, expect, it } from 'vitest';
import biome from '../../../biome.json';
import baseTsconfig from '../tsconfig/base.json';

it('imports runtime export modules without throwing', { timeout: 20_000 }, async () => {
  await expect(import('../src/playwright-environment')).resolves.toBeTruthy();
  await expect(import('../src/vitest-browser')).resolves.toBeTruthy();
});

describe('biome configuration', () => {
  it('has linter enabled and extends ultracite presets', () => {
    expect(biome.linter?.enabled).toBe(true);
    // Now using Ultracite presets instead of recommended rules
    expect(biome.extends).toContain('ultracite/biome/core');
    expect(biome.extends).toContain('ultracite/biome/react');
  });

  it('includes node_modules in ignore list', () => {
    expect(biome.files?.includes).toContain('!**/node_modules');
  });
});

describe('tsconfig presets', () => {
  it('base compiler options are set', () => {
    expect(baseTsconfig.compilerOptions?.module).toBe('ESNext');
    expect(baseTsconfig.compilerOptions?.strict).toBe(true);
  });
});
