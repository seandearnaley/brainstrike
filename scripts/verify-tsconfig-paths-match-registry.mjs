// Guard: root tsconfig.json `compilerOptions.paths` stays HAND-WRITTEN (tsc
// reads it directly at type-check time — it cannot consume a JS module), but
// every package-root key it defines for a package the workspaceSrcAliases
// registry (packages/test-utils/workspace-src-aliases.mjs, Series C R6) ALSO
// source-aliases must point at the SAME resolved source file the registry
// would emit. tsconfig paths are VERIFIED against the single source instead
// of hand-synced with it.
//
// SCOPE: only PACKAGE-ROOT specifiers (`@brainstrike/pkg`, no subpath) are
// checked — the registry's bare-specifier entry per package. Subpath exports
// (`@brainstrike/pkg/sub`) are out of scope; tsconfig's `paths` already
// carries a handful of those as deliberate renamed-entry pins alongside the
// wildcard `@brainstrike/pkg/*` -> `./packages/pkg/src/*` form tsc needs for
// arbitrary subpath imports to type-check, which has no registry counterpart
// to verify against (the registry emits exact per-export subpath aliases only
// — see its own header comment).
//
// A package the registry EXCLUDES (DEFAULT_SRC_ALIAS_EXCLUSIONS, e.g.
// @brainstrike/agent — tsconfig intentionally points its root at
// dist/index.d.ts for type-only consumption of the built surface) has no
// registry root entry to compare against, so it is OUT of this guard's scope
// by construction — not a silent skip, a designed non-applicability.
//
// FAILS when (NO SILENT FALLBACKS):
//  - a package the registry source-aliases has NO tsconfig.json `paths` entry
//    for its bare specifier (the change this guard exists to catch: a package
//    added to the registry but forgotten in tsconfig), or
//  - the tsconfig paths entry resolves (via normal directory/index-file
//    probing, mirroring TypeScript's own module resolution for a bare
//    specifier mapped to a directory) to a DIFFERENT source file than the
//    registry emits for that same package.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSrcAliases } from '../packages/test-utils/workspace-src-aliases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** Escape a specifier for embedding in a RegExp (mirrors the registry's own helper). */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Resolve a tsconfig `paths` target (relative to `repoRoot`) to an existing
 * source file the same way TypeScript resolves a bare specifier mapped to a
 * directory or a specific file: the target as-is if it is already a file,
 * else probing `<target>.<ext>` and `<target>/index.<ext>`.
 */
function resolveTsconfigPathTarget(repoRoot, relTarget) {
  const abs = resolve(repoRoot, relTarget);
  if (existsSync(abs) && statSync(abs).isFile()) {
    return abs;
  }
  for (const ext of SRC_EXTENSIONS) {
    if (existsSync(`${abs}${ext}`)) {
      return `${abs}${ext}`;
    }
  }
  for (const ext of SRC_EXTENSIONS) {
    const indexFile = join(abs, `index${ext}`);
    if (existsSync(indexFile)) {
      return indexFile;
    }
  }
  return null;
}

/**
 * Find the registry's PACKAGE-ROOT alias entry for `name` (an exact-regex
 * `^name$` entry, or the rarer bare-string wildcard-root form — see
 * workspaceSrcAliases' `packageAliasEntries`/`wildcardEntry`) and return its
 * resolved replacement file, or null if the registry has no root entry for
 * this package (excluded, or no source dir).
 */
function registryRootTarget(aliasEntries, name) {
  const exactSource = `^${escapeRegExp(name)}$`;
  for (const { find, replacement } of aliasEntries) {
    if (find instanceof RegExp && find.source === exactSource) {
      return replacement;
    }
    if (typeof find === 'string' && find === name) {
      return replacement;
    }
  }
  return null;
}

/**
 * Scan `packagesDir` for every `@brainstrike/*` package name (mirrors the
 * registry's own package discovery, but independent of its exclusion list —
 * this guard needs to know about EVERY package, including excluded ones, to
 * correctly treat them as out-of-scope rather than silently skipping them).
 */
function listWorkspacePackageNames(packagesDir) {
  const names = [];
  for (const dirName of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, dirName);
    if (!statSync(pkgDir).isDirectory()) {
      continue;
    }
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@brainstrike/')) {
      names.push(pkg.name);
    }
  }
  return names;
}

/**
 * Find every @brainstrike/* package-root tsconfig.json `paths` entry that
 * diverges from (or is missing relative to) the workspaceSrcAliases registry.
 *
 * @param {{ repoRoot?: string, packagesDir?: string, tsconfigPath?: string }} options
 * @returns {{ package: string, problem: string }[]}
 */
export function findTsconfigPathsRegistryMismatches(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..');
  const packagesDir = options.packagesDir ?? join(repoRoot, 'packages');
  const tsconfigPath = options.tsconfigPath ?? join(repoRoot, 'tsconfig.json');

  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  const paths = tsconfig.compilerOptions?.paths ?? {};

  const aliasEntries = workspaceSrcAliases(packagesDir);
  const violations = [];

  for (const name of listWorkspacePackageNames(packagesDir)) {
    const registryTarget = registryRootTarget(aliasEntries, name);
    if (registryTarget === null) {
      continue; // excluded from the registry (e.g. agent) or no src/ dir — out of scope
    }

    const tsconfigEntry = paths[name];
    if (!(Array.isArray(tsconfigEntry) && tsconfigEntry.length > 0)) {
      violations.push({
        package: name,
        problem:
          `the registry source-aliases '${name}' to ${registryTarget}, but tsconfig.json ` +
          `compilerOptions.paths has no entry for '${name}' — add it (pointing at the package's ` +
          'src dir or root source file) so TypeScript resolves it the same way the runtime registry does.',
      });
      continue;
    }

    const resolved = resolveTsconfigPathTarget(repoRoot, tsconfigEntry[0]);
    if (resolved === null) {
      violations.push({
        package: name,
        problem: `tsconfig.json paths['${name}'] = '${tsconfigEntry[0]}' does not resolve to an existing source file`,
      });
      continue;
    }
    if (resolved !== registryTarget) {
      violations.push({
        package: name,
        problem:
          `tsconfig.json paths['${name}'] resolves to ${resolved}, but the workspaceSrcAliases ` +
          `registry resolves '${name}' to ${registryTarget} — they must point at the same file ` +
          '(single source of truth: fix tsconfig.json to match, or fix the package export the ' +
          'registry derives from if that is what is wrong).',
      });
    }
  }
  return violations;
}

async function main() {
  const violations = findTsconfigPathsRegistryMismatches();
  if (violations.length === 0) {
    process.stdout.write('verify-tsconfig-paths-match-registry: OK\n');
    return;
  }
  process.stderr.write(
    `verify-tsconfig-paths-match-registry: ${violations.length} mismatch(es):\n` +
      violations.map((v) => `  - ${v.package}: ${v.problem}`).join('\n') +
      '\n'
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
