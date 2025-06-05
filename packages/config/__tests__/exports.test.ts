import { describe, it, expect } from 'vitest';
import biome from '../biome/biome.json';
import baseTsconfig from '../tsconfig/base.json';
import reactLibrary from '../tsconfig/react-library.json';

// Ensure package entry can be imported without error
it('imports package entry without throwing', () => {
  expect(() => require('..')).not.toThrow();
});

describe('biome configuration', () => {
  it('has recommended rules enabled', () => {
    expect(biome.linter?.enabled).toBe(true);
    expect(biome.linter?.rules?.recommended).toBe(true);
  });

  it('includes node_modules in ignore list', () => {
    expect(biome.files?.ignore).toContain('**/node_modules/**');
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
