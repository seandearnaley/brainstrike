// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  readonly relativePath: string;
  readonly source: string;
}

const APP_STATE_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_STATE_PACKAGE_ROOT = path.resolve(APP_STATE_SRC_ROOT, '..');
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);
const FORBIDDEN_RUNTIME_PACKAGE_PATTERN =
  /@brainstrike\/(?:agent|embeddings|settings-ui|ui)(?:\/|['"])/;

function collectProductionSources(directory: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        files.push(...collectProductionSources(fullPath));
      }
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.includes('.test.')
    ) {
      files.push({
        relativePath: path.relative(APP_STATE_SRC_ROOT, fullPath),
        source: readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return files;
}

function findForbiddenRuntimeImports(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ source }) => FORBIDDEN_RUNTIME_PACKAGE_PATTERN.test(source))
    .map(({ relativePath }) => relativePath);
}

function exportedSourceViolations(packageJson: {
  exports?: Record<string, { import?: string; types?: string }>;
}): string[] {
  const violations: string[] = [];
  for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
    if (subpath === '.' || subpath.includes('*')) {
      violations.push(`${subpath}: root and wildcard exports are forbidden`);
      continue;
    }
    const distTarget = target.import;
    if (!(distTarget?.startsWith('./dist/') && target.types?.startsWith('./dist/'))) {
      violations.push(`${subpath}: import and types targets must live in dist`);
      continue;
    }
    const relativeStem = distTarget.slice('./dist/'.length).replace(/\.js$/, '');
    const candidates = [
      path.join(APP_STATE_SRC_ROOT, `${relativeStem}.ts`),
      path.join(APP_STATE_SRC_ROOT, `${relativeStem}.tsx`),
      path.join(APP_STATE_SRC_ROOT, relativeStem, 'index.ts'),
      path.join(APP_STATE_SRC_ROOT, relativeStem, 'index.tsx'),
    ];
    if (!candidates.some((candidate) => existsSync(candidate))) {
      violations.push(`${subpath}: ${distTarget} has no source module`);
    }
  }
  return violations;
}

function readPackageJson(): {
  dependencies?: Record<string, string>;
  exports?: Record<string, { import?: string; require?: string; types?: string }>;
} {
  return JSON.parse(readFileSync(path.join(APP_STATE_PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, { import?: string; require?: string; types?: string }>;
  };
}

function playwrightStoreVersionExportViolation(
  packageJson: ReturnType<typeof readPackageJson>
): string | undefined {
  const target = packageJson.exports?.['./stores/assistant-preferences-store-version'];
  if (!target) {
    return 'Playwright store-version export is missing';
  }
  if (target.require !== target.import) {
    return 'Playwright store-version export must resolve identically for import and require';
  }
  return;
}

describe('app-state package boundary', () => {
  it('keeps the complete production source graph free of runtime and settings UI packages', () => {
    const files = collectProductionSources(APP_STATE_SRC_ROOT);

    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(findForbiddenRuntimeImports(files)).toEqual([]);
    expect(readPackageJson().dependencies).not.toHaveProperty('@brainstrike/ui');
  });

  it('exports only explicit subpaths backed by source modules', () => {
    const packageJson = readPackageJson();

    expect(Object.keys(packageJson.exports ?? {}).length).toBeGreaterThanOrEqual(35);
    expect(exportedSourceViolations(packageJson)).toEqual([]);
    expect(playwrightStoreVersionExportViolation(packageJson)).toBeUndefined();
  });

  it('money controls detect a forbidden UI import and an unresolved export target', () => {
    const files = collectProductionSources(APP_STATE_SRC_ROOT);
    const controlFile = files[0];
    expect(controlFile).toBeDefined();
    const mutatedFiles = files.map((file) =>
      file === controlFile
        ? { ...file, source: `${file.source}\nimport '@brainstrike/ui';\n` }
        : file
    );
    expect(findForbiddenRuntimeImports(mutatedFiles)).toEqual([controlFile?.relativePath]);

    const packageJson = readPackageJson();
    const firstExport = Object.entries(packageJson.exports ?? {})[0];
    expect(firstExport).toBeDefined();
    if (!firstExport) {
      throw new Error('App-state export control requires at least one real export');
    }
    const [subpath, target] = firstExport;
    const mutatedPackageJson = {
      ...packageJson,
      exports: {
        ...packageJson.exports,
        [subpath]: { ...target, import: './dist/control-missing.js' },
      },
    };
    expect(exportedSourceViolations(mutatedPackageJson)).toContain(
      `${subpath}: ./dist/control-missing.js has no source module`
    );

    const storeVersionExport =
      packageJson.exports?.['./stores/assistant-preferences-store-version'];
    expect(storeVersionExport).toBeDefined();
    const { require: removedRequire, ...storeVersionExportWithoutRequire } =
      storeVersionExport ?? {};
    expect(removedRequire).toBe(storeVersionExport?.import);
    const mutatedPlaywrightPackageJson = {
      ...packageJson,
      exports: {
        ...packageJson.exports,
        './stores/assistant-preferences-store-version': storeVersionExportWithoutRequire,
      },
    };
    expect(playwrightStoreVersionExportViolation(mutatedPlaywrightPackageJson)).toBe(
      'Playwright store-version export must resolve identically for import and require'
    );
  });
});
