import { describe, expect, it } from 'vitest';
import biome from '../../../biome.json';
import baseTsconfig from '../tsconfig/base.json';
import reactLibrary from '../tsconfig/react-library.json';

// Ensure package entry can be imported without error
it('imports package entry without throwing', () => {
  expect(() => require('..')).not.toThrow();
});

describe('biome configuration', () => {
  it('has linter enabled with recommended rules', () => {
    expect(biome.linter?.enabled).toBe(true);
    expect(biome.linter?.rules?.recommended).toBe(true);
    expect(biome.linter?.rules?.correctness).toBeDefined();
  });

  it('includes node_modules in ignore list', () => {
    expect(biome.files?.includes).toContain('!**/node_modules/**');
  });
});

describe('tsconfig presets', () => {
  it('base compiler options are set', () => {
    expect(baseTsconfig.compilerOptions?.module).toBe('ESNext');
    expect(baseTsconfig.compilerOptions?.strict).toBe(true);
  });

  it('react-library extends base', () => {
    expect(reactLibrary.extends).toBe('./base.json');
  });
});
