// @vitest-environment node
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

/**
 * The Tailwind `@source` shim. It is a stylesheet, not a module: Tailwind reads
 * it to learn that this package's `src` must be scanned for utility classes,
 * and the app CSS entrypoints `@import` it directly. It therefore has no dist
 * build and no source module, and the checks below must not demand either.
 *
 * It is validated on its own terms instead — the file exists and actually
 * carries the `@source` directive — because an export pointing at a missing or
 * empty stylesheet fails exactly as silently as the defect this shim exists to
 * prevent (see scripts/__tests__/tailwind-source-coverage.test.mjs).
 */
const STYLES_SHIM_SUBPATH = './styles.css';

function stylesShimViolations(target: unknown): string[] {
  if (target !== STYLES_SHIM_SUBPATH) {
    return [`${STYLES_SHIM_SUBPATH}: must map to "${STYLES_SHIM_SUBPATH}"`];
  }
  const shimPath = path.join(SETTINGS_UI_PACKAGE_ROOT, 'styles.css');
  if (!existsSync(shimPath)) {
    return [`${STYLES_SHIM_SUBPATH}: styles.css does not exist`];
  }
  if (!/@source\s+["']\.\/src["']/.test(readFileSync(shimPath, 'utf8'))) {
    return [`${STYLES_SHIM_SUBPATH}: styles.css does not declare @source "./src"`];
  }
  return [];
}

function exportedSourceViolations(packageJson: {
  exports?: Record<string, { import?: string; types?: string } | string>;
}): string[] {
  const violations: string[] = [];
  for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
    if (subpath === '.' || subpath.includes('*')) {
      violations.push(`${subpath}: root and wildcard exports are forbidden`);
      continue;
    }
    if (subpath === STYLES_SHIM_SUBPATH) {
      violations.push(...stylesShimViolations(target));
      continue;
    }
    if (typeof target === 'string') {
      violations.push(`${subpath}: only ${STYLES_SHIM_SUBPATH} may map to a bare file path`);
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
  exports?: Record<string, { import?: string; types?: string } | string>;
} {
  return JSON.parse(readFileSync(path.join(SETTINGS_UI_PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, { import?: string; types?: string } | string>;
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
    // Explicitly a MODULE export, not merely the first entry: `./styles.css` is
    // a bare file path with no dist target, so mutating it would exercise a
    // different branch than the one this control is meant to prove.
    const moduleExport = Object.entries(packageJson.exports ?? {}).find(
      (entry): entry is [string, { import?: string; types?: string }] =>
        typeof entry[1] === 'object'
    );
    expect(moduleExport).toBeDefined();
    if (!moduleExport) {
      throw new Error('Settings UI export control requires at least one real module export');
    }
    const [subpath, target] = moduleExport;
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
