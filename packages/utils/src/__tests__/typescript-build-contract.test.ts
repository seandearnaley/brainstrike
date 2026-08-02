import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  readonly exports: Record<
    string,
    {
      readonly default?: string;
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
    .filter(([exportName, exportConfig]) => exportName !== '.' && Boolean(exportConfig.default))
    .map(([exportName]) => exportName.replace(/^\.\//u, ''))
    .sort();
}

function runtimeConditionViolations(exportsMap: PackageJson['exports']): string[] {
  const violations: string[] = [];
  for (const [exportName, exportConfig] of Object.entries(exportsMap)) {
    if (exportConfig.import !== undefined) {
      violations.push(`${exportName} declares import`);
    }
    if (exportConfig.require !== undefined) {
      violations.push(`${exportName} declares require`);
    }
  }
  return violations;
}

describe('utils emitted TypeScript build contract', () => {
  it('emits every runtime package subpath declared by the export map', () => {
    const exportNames = runtimeSubpathExportNames();
    expect(exportNames.length).toBeGreaterThanOrEqual(34);
    expect(runtimeConditionViolations(packageJson.exports)).toEqual([]);
    for (const exportName of exportNames) {
      const exportConfig = packageJson.exports[`./${exportName}`];
      expect(exportConfig?.default).toBe(`./dist/${exportName}.js`);
      expect(exportConfig?.types).toBe(`./dist/${exportName}.d.ts`);
      expect(existsSync(path.resolve(packageRoot, exportConfig?.default ?? ''))).toBe(true);
      expect(existsSync(path.resolve(packageRoot, exportConfig?.types ?? ''))).toBe(true);
    }
  });

  it('MONEY TEST: rejects a fake CommonJS condition without a CJS artifact', () => {
    const mutatedExports = structuredClone(packageJson.exports);
    mutatedExports['./collator'] = {
      ...mutatedExports['./collator'],
      require: './dist/collator.js',
    };
    expect(runtimeConditionViolations(mutatedExports)).toContain('./collator declares require');
  });

  it('uses the canonical tsc-only Node ESM library shape', () => {
    expect(packageJson.scripts.build).toBe('node ../../scripts/prune-stale-dist.mjs && tsc -b .');
    expect(packageJson.type).toBe('module');
    expect(tsconfig.extends).toBe('../../packages/config/tsconfig/node-library.json');
    expect(tsconfig.compilerOptions?.emitDeclarationOnly).toBeUndefined();
  });

  it('emits per-source modules without bundler split chunks', () => {
    const distEntries = readdirSync(path.join(packageRoot, 'dist'));
    expect(distEntries.filter((entry) => /^chunk-.+\.js$/u.test(entry))).toEqual([]);
  });
});
