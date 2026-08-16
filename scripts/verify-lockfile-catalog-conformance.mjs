// Guard (BST-1324): every pnpm-lock.yaml importer entry whose specifier is in
// the `catalog:` family must have resolved INSIDE its catalog — same version
// the lockfile's own `catalogs:` block records, which in turn must match
// pnpm-workspace.yaml — and that version must actually exist in the lockfile's
// `packages:`/`snapshots:` sections.
//
// WHY THIS EXISTS. pnpm-lock.yaml merges TEXTUALLY. On 2026-08-16 two
// concurrent dependency PRs (#2470/#2475) spliced into a lockfile where
// `packages/utils`'s `@stryker-mutator/api` importer entry said `catalog:` but
// still carried `version: 9.6.1` from a resolution predating the catalog's
// move to ^10.0.0. The file was syntactically valid and semantically broken:
// every CI job in every workflow failed at `pnpm install --frozen-lockfile`
// (ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY), twice (#2483, then again #2485),
// because per-PR CI cannot see a breakage that only exists in the MERGED
// result. scripts/verify-catalog-references.mjs cannot catch it either — it
// never opens the lockfile; it verifies that manifests SAY `catalog:`, not
// that the lockfile RESOLVED them inside the catalog.
//
// WHY NO `yaml` IMPORT. This guard's CI seat is a Static-job step BEFORE
// `pnpm install --frozen-lockfile` (which is where the outage class kills the
// job — a guard behind that install can never fire on the file it exists to
// catch, per the #2488 review). Before the install there is no node_modules,
// so the script must run on a bare checkout with the runner's system Node.
// The subset parser below reads exactly the shapes these two files use in the
// sections this guard needs: indentation-scoped `key:` / `key: value` lines
// with optional single-quoting and full-line comments. pnpm-lock.yaml is
// machine-emitted with deterministic formatting; the workspace catalog blocks
// are flat scalar maps. The paired test's REAL-TREE assertion (541 entries
// today) is the standing proof the parser keeps reading the real files.
//
// A second, later invocation still runs with rich context via the paired test
// under `pnpm test:scripts` — that one also covers the install-SILENT class
// (a stale importer resolution whose old snapshot still exists installs fine
// and ships the wrong version).
//
// To fix a failure: DO NOT hand-edit pnpm-lock.yaml. Run a real `pnpm install`
// (not --frozen-lockfile) so pnpm regenerates the importer resolutions from
// the catalog, and commit the result.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Anti-vacuous-green floor. The real tree has ~540 catalog-family importer
 * entries; if discovery ever reports fewer than this, the guard is checking a
 * shadow of the workspace and must say so rather than pass silently.
 */
export const MIN_CATALOG_IMPORTER_ENTRIES = 300;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Strip one level of single- or double-quoting. */
function unquote(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal indentation-scoped YAML subset parser — maps of maps of scalars,
 * which is everything the four sections this guard reads ever contain. Flow
 * values (`{integrity: …}`) are kept as opaque scalars; full-line comments and
 * blank lines are skipped. NOT a general YAML parser, deliberately: see the
 * header for why this file cannot import one.
 */
export function parseYamlSubset(text) {
  const root = {};
  // Stack of [indent, container] from outermost to innermost.
  const stack = [[-1, root]];
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) {
      continue;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    // List items only appear in sections this guard ignores (e.g. `packages:`
    // globs at the top of the workspace file); represent them as opaque.
    if (line.startsWith('- ')) {
      continue;
    }
    const colonIndex = findKeyColon(line);
    if (colonIndex === -1) {
      continue;
    }
    const key = unquote(line.slice(0, colonIndex));
    const rest = line.slice(colonIndex + 1).trim();
    while (stack.length > 1 && stack.at(-1)[0] >= indent) {
      stack.pop();
    }
    const parent = stack.at(-1)[1];
    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push([indent, child]);
    } else {
      parent[key] = unquote(rest);
    }
  }
  return root;
}

/**
 * The colon that separates a YAML key from its value: the first colon outside
 * quotes that is at end-of-line or followed by a space. Handles quoted keys
 * containing colons (`'npm:foo': bar`) and values containing colons.
 */
function findKeyColon(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (
      ch === ':' &&
      !inSingle &&
      !inDouble &&
      (i === line.length - 1 || line[i + 1] === ' ')
    ) {
      return i;
    }
  }
  return -1;
}

/** Strip the peer-resolution suffix: `10.0.0(vitest@4.1.10)` -> `10.0.0`. */
function baseVersion(version) {
  const parenIndex = version.indexOf('(');
  return parenIndex === -1 ? version : version.slice(0, parenIndex);
}

/**
 * The `packages:`/`snapshots:` key a resolved importer version must appear
 * under. Plain versions key as `name@version`; `npm:` alias resolutions
 * (e.g. typescript -> `@typescript/typescript6@6.0.2`) already ARE the
 * `realname@version` key.
 */
function expectedStoreKey(name, base) {
  return base.lastIndexOf('@') > 0 ? base : `${name}@${base}`;
}

/**
 * What the importer's base version must be for `name`, derived from the
 * lockfile's catalogs block: the recorded version for plain entries, or
 * `aliasedName@version` when the catalog specifier is an `npm:` alias.
 */
function expectedImporterBase(catalogEntry) {
  const specifier = String(catalogEntry.specifier ?? '');
  if (specifier.startsWith('npm:')) {
    const alias = specifier.slice('npm:'.length);
    const versionSeparator = alias.lastIndexOf('@');
    const aliasedName = versionSeparator > 0 ? alias.slice(0, versionSeparator) : alias;
    return `${aliasedName}@${catalogEntry.version}`;
  }
  return String(catalogEntry.version);
}

/**
 * Resolve a `catalog:`-family specifier to its catalog name: `catalog:` and
 * `catalog:default` -> `default`; `catalog:react18` -> `react18`.
 */
function catalogNameFromSpecifier(specifier) {
  const suffix = specifier.slice('catalog:'.length).trim();
  return suffix === '' ? 'default' : suffix;
}

/**
 * The workspace's catalog ranges, keyed by catalog name. `catalog:` (singular)
 * is the default catalog; `catalogs:` (plural) holds named ones.
 */
function workspaceCatalogsByName(workspace) {
  const byName = {};
  if (workspace.catalog && typeof workspace.catalog === 'object') {
    byName.default = workspace.catalog;
  }
  if (workspace.catalogs && typeof workspace.catalogs === 'object') {
    for (const [name, entries] of Object.entries(workspace.catalogs)) {
      if (typeof entries === 'object') {
        byName[name] = entries;
      }
    }
  }
  return byName;
}

/**
 * Walk the lockfile and return every conformance violation, plus a separate
 * discovery-floor verdict so a broken parser reports as a discovery failure,
 * not a lockfile one. Pure function of the two files so the paired test can
 * drive it against synthetic trees.
 */
export function findLockfileCatalogViolations(root, { minEntries } = {}) {
  const workspace = parseYamlSubset(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const lockfile = parseYamlSubset(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));

  const workspaceCatalogs = workspaceCatalogsByName(workspace);
  const lockCatalogs =
    lockfile.catalogs && typeof lockfile.catalogs === 'object' ? lockfile.catalogs : {};
  const importers = lockfile.importers ?? {};
  const packageKeys = new Set(Object.keys(lockfile.packages ?? {}));
  const snapshotKeys = Object.keys(lockfile.snapshots ?? {});

  const violations = [];
  let checkedCount = 0;

  // The lockfile's catalog blocks must mirror pnpm-workspace.yaml. Entries the
  // workspace dropped are pruned by pnpm (cleanupUnusedCatalogs), so only
  // check the direction that matters: everything the lockfile claims a
  // catalog says must be what the workspace actually says.
  for (const [catalogName, lockEntries] of Object.entries(lockCatalogs)) {
    const workspaceEntries = workspaceCatalogs[catalogName];
    if (!workspaceEntries) {
      violations.push(
        `pnpm-lock.yaml has a catalogs block '${catalogName}' that pnpm-workspace.yaml does not ` +
          'define — stale lockfile catalog.'
      );
      continue;
    }
    for (const [name, entry] of Object.entries(lockEntries)) {
      const workspaceRange = workspaceEntries[name];
      if (workspaceRange === undefined) {
        violations.push(
          `catalogs.${catalogName}['${name}'] exists in pnpm-lock.yaml but '${name}' is not in ` +
            `the pnpm-workspace.yaml '${catalogName}' catalog — stale lockfile catalog entry.`
        );
        continue;
      }
      if (String(entry.specifier) !== String(workspaceRange)) {
        violations.push(
          `catalogs.${catalogName}['${name}'] records specifier '${entry.specifier}' but ` +
            `pnpm-workspace.yaml pins '${workspaceRange}' — the lockfile catalog block has ` +
            'drifted from the workspace catalog. Re-run `pnpm install` to regenerate.'
        );
      }
    }
  }

  for (const [importerPath, importer] of Object.entries(importers)) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, entry] of Object.entries(importer?.[field] ?? {})) {
        const specifier = String(entry.specifier ?? '');
        // The whole catalog: family is in scope — `catalog:` (default),
        // `catalog:default` (explicit spelling), `catalog:<name>` (named).
        // Skipping any of them would silently shrink coverage (NO SILENT
        // FALLBACKS), so scope is decided by prefix, never by exact match.
        if (!specifier.startsWith('catalog:')) {
          continue;
        }
        checkedCount += 1;

        const catalogName = catalogNameFromSpecifier(specifier);
        const catalogEntry = lockCatalogs[catalogName]?.[name];
        if (!catalogEntry) {
          violations.push(
            `${importerPath} > ${field} > ${name}: specifier is '${specifier}' but the lockfile ` +
              `has no catalogs.${catalogName} entry for '${name}' — the importer resolution ` +
              `(${entry.version}) is unaccountable.`
          );
          continue;
        }

        const base = baseVersion(String(entry.version));
        const expectedBase = expectedImporterBase(catalogEntry);
        if (base !== expectedBase) {
          violations.push(
            `${importerPath} > ${field} > ${name}: resolved to ${base} but the catalog ` +
              `resolution is ${expectedBase} (workspace range '${catalogEntry.specifier}') — ` +
              'a stale importer entry, the textual-merge outage class (#2483/#2485).'
          );
          continue;
        }

        // One root cause, one violation: a version absent from `packages:` is
        // near-always absent from `snapshots:` too.
        const storeKey = expectedStoreKey(name, base);
        const inPackages = packageKeys.has(storeKey);
        const inSnapshots = snapshotKeys.some(
          (key) => key === storeKey || key.startsWith(`${storeKey}(`)
        );
        if (!(inPackages && inSnapshots)) {
          const missing = [inPackages ? null : 'packages', inSnapshots ? null : 'snapshots'].filter(
            Boolean
          );
          violations.push(
            `${importerPath} > ${field} > ${name}: resolved version ${base} has no '${storeKey}' ` +
              `entry in the lockfile ${missing.join(' or ')} section — ` +
              '`pnpm install --frozen-lockfile` will fail on this file.'
          );
        }
      }
    }
  }

  const floor = minEntries ?? MIN_CATALOG_IMPORTER_ENTRIES;
  const floorViolation =
    checkedCount < floor
      ? `Only ${checkedCount} catalog-family importer entries were found (floor: ${floor}) — ` +
        'discovery is broken (parser drift?) or the lockfile lost its importers; refusing a ' +
        'vacuous pass.'
      : null;

  return { checkedCount, floorViolation, violations };
}

export function formatLockfileViolations(violations) {
  return violations.map((violation) => `  - ${violation}`).join('\n');
}

export function main({ repoRoot = REPO_ROOT } = {}) {
  const { checkedCount, floorViolation, violations } = findLockfileCatalogViolations(repoRoot);
  if (violations.length > 0) {
    console.error(
      `pnpm-lock.yaml fails catalog conformance (${violations.length} violation(s), ` +
        `${checkedCount} entries checked):\n${formatLockfileViolations(violations)}`
    );
    process.exitCode = 1;
  }
  if (floorViolation) {
    console.error(`Guard discovery failure (not a lockfile defect):\n  - ${floorViolation}`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(
      `pnpm-lock.yaml catalog conformance OK: ${checkedCount} catalog-family importer entries ` +
        'all resolve inside their catalogs with matching snapshots.'
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
