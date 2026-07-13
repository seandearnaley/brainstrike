// Guard against #1066/#1207 regressions: a package test lane that imports another
// @brainstrike/* workspace package at RUNTIME while its vitest config declares NO
// workspace-src aliasing resolves that dep from BUILT dist (via package `exports`).
// Stale/broken dist then silently passes — the incident class.
//
// This validator flags any packages/* that imports a sibling workspace package at
// runtime (in src or tests) yet no vitest config in that package declares
// workspace-src aliasing (the shared `workspaceSrcAliases` registry, or an
// explicit `../<pkg>/src` alias). A documented allowlist covers the few packages
// that legitimately consume built artifacts. NO silent fallback: an un-aliased,
// un-allowlisted importer is a hard failure.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Packages that legitimately DO NOT source-alias every workspace import, with the
 * reason. Keyed by package name. Keep this list short and justified.
 */
export const WORKSPACE_SRC_ALIAS_ALLOWLIST = Object.freeze({
  // (currently empty — every workspace-importing package aliases its deps to src)
});

const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts)$/;
const VITEST_CONFIG_RE = /^vitest\..*\.(mts|cts|ts|mjs|cjs|js)$/;
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '__mocks__']);

/** Recursively collect source files under `dir`. */
function collectSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (SOURCE_FILE_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Runtime @brainstrike/* root package names imported by a package (excluding self + type-only). */
function collectRuntimeWorkspaceDeps(pkgDir, selfName) {
  const deps = new Set();
  for (const file of collectSourceFiles(pkgDir)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/from\s*['"](@brainstrike\/[^'"]+)['"]/);
      if (!match) {
        continue;
      }
      // Skip type-only imports — erased at compile time, never resolved at runtime.
      if (/^\s*import\s+type\b|^\s*export\s+type\b/.test(line)) {
        continue;
      }
      const rootPkg = match[1].split('/').slice(0, 2).join('/');
      if (rootPkg !== selfName) {
        deps.add(rootPkg);
      }
    }
  }
  return deps;
}

/** True if any vitest config in the package declares workspace-src aliasing. */
function declaresWorkspaceSrcAliasing(pkgDir) {
  const configFiles = readdirSync(pkgDir).filter(
    (name) => VITEST_CONFIG_RE.test(name) && !name.includes('.setup.')
  );
  for (const name of configFiles) {
    const text = readFileSync(join(pkgDir, name), 'utf8');
    // Either the shared registry, or an explicit sibling-package `src` alias.
    if (text.includes('workspaceSrcAliases') || /\.\.\/[\w.-]+\/src\b/.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Scan the monorepo `packages/` dir and return violations: importing packages
 * with no workspace-src aliasing and no allowlist entry.
 *
 * @param {{ packagesRoot?: string, allowlist?: Record<string,string> }} [options]
 * @returns {{ package: string, deps: string[] }[]}
 */
export function findWorkspaceSrcAliasViolations(options = {}) {
  const packagesRoot = options.packagesRoot ?? join(HERE, '..', 'packages');
  const allowlist = options.allowlist ?? WORKSPACE_SRC_ALIAS_ALLOWLIST;
  const violations = [];

  for (const dirName of readdirSync(packagesRoot)) {
    const pkgDir = join(packagesRoot, dirName);
    if (!statSync(pkgDir).isDirectory()) {
      continue;
    }
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    const selfName = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name;
    if (typeof selfName !== 'string' || !selfName.startsWith('@brainstrike/')) {
      continue;
    }
    // Only packages that actually run a vitest lane are in scope.
    const hasVitestConfig = readdirSync(pkgDir).some(
      (name) => VITEST_CONFIG_RE.test(name) && !name.includes('.setup.')
    );
    if (!hasVitestConfig) {
      continue;
    }
    const deps = collectRuntimeWorkspaceDeps(pkgDir, selfName);
    if (deps.size === 0 || Object.hasOwn(allowlist, selfName)) {
      continue;
    }
    if (!declaresWorkspaceSrcAliasing(pkgDir)) {
      violations.push({ deps: [...deps].sort(), package: selfName });
    }
  }
  return violations;
}
