import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface SourceFile {
  readonly relativePath: string;
  readonly source: string;
}

const SETTINGS_UI_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_UI_PACKAGE_ROOT = path.resolve(SETTINGS_UI_SRC_ROOT, '..');
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);
const FORBIDDEN_RUNTIME_PACKAGE_PATTERN =
  /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/(?:agent|embeddings)(?:\/|['"])/;

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
        relativePath: path.relative(SETTINGS_UI_SRC_ROOT, fullPath),
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
      path.join(SETTINGS_UI_SRC_ROOT, `${relativeStem}.ts`),
      path.join(SETTINGS_UI_SRC_ROOT, `${relativeStem}.tsx`),
      path.join(SETTINGS_UI_SRC_ROOT, relativeStem, 'index.ts'),
      path.join(SETTINGS_UI_SRC_ROOT, relativeStem, 'index.tsx'),
    ];
    if (!candidates.some((candidate) => existsSync(candidate))) {
      violations.push(`${subpath}: ${distTarget} has no source module`);
    }
  }
  return violations;
}

function readPackageJson(): {
  dependencies?: Record<string, string>;
  exports?: Record<string, { import?: string; types?: string }>;
} {
  return JSON.parse(readFileSync(path.join(SETTINGS_UI_PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, { import?: string; types?: string }>;
  };
}

describe('settings-ui package boundary', () => {
  it('depends on app-state while keeping agent and embedding implementations out', () => {
    const files = collectProductionSources(SETTINGS_UI_SRC_ROOT);
    const packageJson = readPackageJson();

    expect(files.length).toBeGreaterThanOrEqual(55);
    expect(findForbiddenRuntimeImports(files)).toEqual([]);
    expect(packageJson.dependencies).toHaveProperty('@brainstrike/app-state', 'workspace:*');
  });

  it('exports only explicit subpaths backed by source modules', () => {
    const packageJson = readPackageJson();

    expect(Object.keys(packageJson.exports ?? {}).length).toBeGreaterThanOrEqual(10);
    expect(exportedSourceViolations(packageJson)).toEqual([]);
  });

  it('money controls detect a forbidden runtime import and an unresolved export target', () => {
    const files = collectProductionSources(SETTINGS_UI_SRC_ROOT);
    const controlFile = files[0];
    expect(controlFile).toBeDefined();
    const mutatedFiles = files.map((file) =>
      file === controlFile
        ? { ...file, source: `${file.source}\nimport control from '@brainstrike/agent';\n` }
        : file
    );
    expect(findForbiddenRuntimeImports(mutatedFiles)).toEqual([controlFile?.relativePath]);

    const packageJson = readPackageJson();
    const firstExport = Object.entries(packageJson.exports ?? {})[0];
    expect(firstExport).toBeDefined();
    if (!firstExport) {
      throw new Error('Settings UI export control requires at least one real export');
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
  });
});
