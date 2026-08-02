import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  readonly exports: Record<
    string,
    {
      readonly import?: string;
      readonly require?: string;
      readonly types?: string;
    }
  >;
  readonly scripts: {
    readonly build?: string;
  };
  readonly type?: string;
}

interface Tsconfig {
  readonly compilerOptions?: {
    readonly emitDeclarationOnly?: boolean;
  };
  readonly extends?: string;
}

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
) as PackageJson;
const tsconfig = JSON.parse(
  readFileSync(path.join(packageRoot, 'tsconfig.json'), 'utf8')
) as Tsconfig;

function runtimeSubpathExportNames(): string[] {
  return Object.entries(packageJson.exports)
    .filter(
      ([exportName, exportConfig]) =>
        exportName !== '.' && Boolean(exportConfig.import ?? exportConfig.require)
    )
    .map(([exportName]) => exportName.replace(/^\.\//u, ''))
    .sort();
}

describe('utils emitted TypeScript build contract', () => {
  it('emits every runtime package subpath declared by the export map', () => {
    for (const exportName of runtimeSubpathExportNames()) {
      const exportConfig = packageJson.exports[`./${exportName}`];
      expect(exportConfig?.import).toBe(`./dist/${exportName}.js`);
      expect(exportConfig?.require).toBe(exportConfig?.import);
      expect(exportConfig?.types).toBe(`./dist/${exportName}.d.ts`);
      expect(existsSync(path.resolve(packageRoot, exportConfig?.import ?? ''))).toBe(true);
      expect(existsSync(path.resolve(packageRoot, exportConfig?.types ?? ''))).toBe(true);
    }
  });

  it('uses the canonical tsc-only Node ESM library shape', () => {
    expect(packageJson.scripts.build).toBe('pnpm run clean && tsc -b .');
    expect(packageJson.type).toBe('module');
    expect(tsconfig.extends).toBe('../../packages/config/tsconfig/node-library.json');
    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBeUndefined();
  });

  it('emits per-source modules without bundler split chunks', () => {
    const distEntries = readdirSync(path.join(packageRoot, 'dist'));
    expect(distEntries.filter((entry) => /^chunk-.+\.js$/u.test(entry))).toEqual([]);
  });
});
