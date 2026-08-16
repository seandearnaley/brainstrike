// Guard (BST-1324): every pnpm-lock.yaml importer entry whose specifier is
// `catalog:` must have resolved INSIDE the catalog — same version the
// lockfile's own `catalogs:` block records, which in turn must match
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
// This guard is install-free (pure YAML + string comparison) and runs in the
// Static lane via its paired test under `pnpm test:scripts`, where it sees the
// merged tree. The `.gitattributes` `pnpm-lock.yaml merge=binary` companion
// prevents the bad splice at merge time; this guard catches a bad lockfile
// whatever produced it.
//
// To fix a failure: DO NOT hand-edit pnpm-lock.yaml. Run a real `pnpm install`
// (not --frozen-lockfile) so pnpm regenerates the importer resolutions from
// the catalog, and commit the result.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Anti-vacuous-green floor. The real tree has ~540 `catalog:` importer entries;
 * if discovery ever reports fewer than this, the guard is checking a shadow of
 * the workspace and must say so rather than pass silently.
 */
export const MIN_CATALOG_IMPORTER_ENTRIES = 300;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

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
 * Walk the lockfile and return every conformance violation. Pure function of
 * the two files so the paired test can drive it against synthetic trees.
 */
export function findLockfileCatalogViolations(root, { minEntries } = {}) {
  const workspace = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const lockfile = parse(readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));

  const workspaceCatalog = workspace.catalog ?? {};
  const lockCatalog = lockfile.catalogs?.default ?? {};
  const importers = lockfile.importers ?? {};
  const packageKeys = new Set(Object.keys(lockfile.packages ?? {}));
  const snapshotKeys = Object.keys(lockfile.snapshots ?? {});

  const violations = [];
  let checkedCount = 0;

  // The lockfile's catalog block must mirror pnpm-workspace.yaml. Entries the
  // workspace dropped are pruned by pnpm (cleanupUnusedCatalogs), so only
  // check the direction that matters: everything the lockfile claims the
  // catalog says must be what the workspace actually says.
  for (const [name, entry] of Object.entries(lockCatalog)) {
    const workspaceRange = workspaceCatalog[name];
    if (workspaceRange === undefined) {
      violations.push(
        `catalogs.default['${name}'] exists in pnpm-lock.yaml but '${name}' is not in the ` +
          'pnpm-workspace.yaml catalog — stale lockfile catalog entry.'
      );
      continue;
    }
    if (String(entry.specifier) !== String(workspaceRange)) {
      violations.push(
        `catalogs.default['${name}'] records specifier '${entry.specifier}' but ` +
          `pnpm-workspace.yaml pins '${workspaceRange}' — the lockfile catalog block has ` +
          'drifted from the workspace catalog. Re-run `pnpm install` to regenerate.'
      );
    }
  }

  for (const [importerPath, importer] of Object.entries(importers)) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, entry] of Object.entries(importer?.[field] ?? {})) {
        if (String(entry.specifier) !== 'catalog:') {
          continue;
        }
        checkedCount += 1;

        const catalogEntry = lockCatalog[name];
        if (!catalogEntry) {
          violations.push(
            `${importerPath} > ${field} > ${name}: specifier is 'catalog:' but the lockfile ` +
              `has no catalogs block entry for '${name}' — the importer resolution ` +
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

        const storeKey = expectedStoreKey(name, base);
        if (!packageKeys.has(storeKey)) {
          violations.push(
            `${importerPath} > ${field} > ${name}: resolved version ${base} has no ` +
              `'${storeKey}' entry in the lockfile packages section — ` +
              '`pnpm install --frozen-lockfile` will fail on this file.'
          );
        }
        if (!snapshotKeys.some((key) => key === storeKey || key.startsWith(`${storeKey}(`))) {
          violations.push(
            `${importerPath} > ${field} > ${name}: resolved version ${base} has no matching ` +
              `snapshot ('${storeKey}') in the lockfile snapshots section — ` +
              '`pnpm install --frozen-lockfile` will fail on this file.'
          );
        }
      }
    }
  }

  const floor = minEntries ?? MIN_CATALOG_IMPORTER_ENTRIES;
  if (checkedCount < floor) {
    violations.push(
      `Only ${checkedCount} 'catalog:' importer entries were found (floor: ${floor}) — ` +
        'discovery is broken or the lockfile lost its importers; refusing a vacuous pass.'
    );
  }

  return { checkedCount, violations };
}

export function formatLockfileViolations(violations) {
  return violations.map((violation) => `  - ${violation}`).join('\n');
}

export function main({ repoRoot = REPO_ROOT } = {}) {
  const { checkedCount, violations } = findLockfileCatalogViolations(repoRoot);
  if (violations.length > 0) {
    console.error(
      `pnpm-lock.yaml fails catalog conformance (${violations.length} violation(s), ` +
        `${checkedCount} entries checked):\n${formatLockfileViolations(violations)}`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `pnpm-lock.yaml catalog conformance OK: ${checkedCount} 'catalog:' importer entries ` +
      'all resolve inside the catalog with matching snapshots.'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
