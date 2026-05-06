import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  readonly exports: Record<
    string,
    {
      readonly import?: string;
      readonly require?: string;
    }
  >;
  readonly scripts: {
    readonly build?: string;
  };
}

interface TsupConfig {
  readonly entry?: unknown;
  readonly splitting?: boolean;
}

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
) as PackageJson;

async function loadTsupConfig(): Promise<TsupConfig> {
  const configModule = (await import(
    pathToFileURL(path.join(packageRoot, 'tsup.config.ts')).href
  )) as {
    readonly default: unknown;
  };

  return configModule.default as TsupConfig;
}

function runtimeSubpathExportNames(): string[] {
  return Object.entries(packageJson.exports)
    .filter(
      ([exportName, exportConfig]) =>
        exportName !== '.' && Boolean(exportConfig.import ?? exportConfig.require)
    )
    .map(([exportName]) => exportName.replace(/^\.\//u, ''))
    .sort();
}

describe('utils tsup build contract', () => {
  it('builds every runtime package subpath from source entries', async () => {
    const config = await loadTsupConfig();
    const entry = config.entry;

    expect(entry).toBeTypeOf('object');
    expect(Array.isArray(entry)).toBe(false);

    const entryMap = entry as Record<string, string>;
    for (const exportName of runtimeSubpathExportNames()) {
      expect(entryMap, `missing tsup entry for package export "./${exportName}"`).toHaveProperty(
        exportName
      );
    }
  });

  it('uses public wrapper files for subpath entries when they exist', async () => {
    const config = await loadTsupConfig();
    const entryMap = config.entry as Record<string, string>;

    for (const exportName of runtimeSubpathExportNames()) {
      const wrapperEntry = `src/${exportName}.ts`;
      if (!existsSync(path.join(packageRoot, wrapperEntry))) {
        continue;
      }

      expect(entryMap[exportName], `entry for "./${exportName}" must use ${wrapperEntry}`).toBe(
        wrapperEntry
      );
    }
  });

  it('uses tsup config as the single source for build entries', () => {
    expect(packageJson.scripts.build).toBe('pnpm run clean && tsc -b . && tsup');
  });

  it('does not emit split chunks for package subpath exports', async () => {
    const config = await loadTsupConfig();

    expect(config.splitting).toBe(false);
  });
});
