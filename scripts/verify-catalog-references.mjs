// Guard: every dependency that has a `catalog:` entry in pnpm-workspace.yaml must
// be referenced as "catalog:" from workspace package.json files — never as a
// literal version.
//
// WHY THIS EXISTS (Series C R8, the syncpack replacement). `catalogMode: strict`
// is NOT a full replacement for `syncpack lint`, and this was verified
// empirically rather than assumed:
//
//   * `pnpm add typescript@5.9.0 --filter @brainstrike/hooks` IS rejected —
//     ERR_PNPM_CATALOG_VERSION_MISMATCH, exit 1. strict mode governs the
//     `pnpm add`/`pnpm update` path, which is how a version normally enters.
//   * Hand-editing a catalogued dep in a package.json to a literal version and
//     running a plain `pnpm install` is SILENTLY ACCEPTED: pnpm resolves a
//     second, parallel version of that package into the lockfile alongside the
//     catalog's, and `pnpm install --frozen-lockfile` then passes too (the
//     lockfile now matches the drifted manifest). Nothing complains.
//
// That second path is a NO SILENT FALLBACKS violation and the hole this guard
// closes: hand edits, bad merge resolutions, and any tool that writes a version
// straight into a manifest. Between `pnpm add`'s native rejection and this
// guard, both paths are covered.
//
// Note for whoever reads this later: syncpack was never wired into CI here
// (grep .github — nothing invoked `deps:lint`), so this guard is the first
// actual CI enforcement of single-source versions this repo has had.
//
// To fix a failure: replace the literal version with "catalog:" and, if the
// version genuinely needs to change, bump it in the `catalog:` block of
// pnpm-workspace.yaml (one place, every consumer). Do NOT weaken this guard or
// drop the dep from the catalog to make a literal pass.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Dependency fields whose entries MUST use "catalog:" for a catalogued name.
 * These are the fields that actually drive installed-version resolution.
 */
export const CATALOG_CHECKED_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

/**
 * `peerDependencies` is DELIBERATELY EXEMPT — this is a rule, not an oversight.
 *
 * A peer range is a compatibility CONTRACT (the broad floor a consumer must
 * satisfy), not an installed-version selection. This repo relies on that
 * distinction structurally: every peer entry declares the broad floor
 * (react ^19.2.4, matching pnpm-workspace.yaml `overrides`) while the
 * dependencies/devDependencies entry declares the exact pin in use
 * (react ^19.2.7). syncpack's default version group flagged that split as a
 * mismatch; it is not one, and "fixing" it would silently widen ~16 packages'
 * published peer contracts.
 *
 * A pnpm catalog entry is a single version string, so pointing a peer range at
 * `catalog:` would REPLACE the floor with the pin. Hence: checked fields resolve
 * versions and must be catalogued; peer ranges express contracts and stay
 * literal. Do not "unify" these without re-deciding the peer floors on purpose.
 */
export const CATALOG_EXEMPT_FIELDS = Object.freeze(['peerDependencies']);

/**
 * Discovery floors. A guard that inspects NOTHING and reports "no violations"
 * is a vacuous green — the same silent-degradation class it exists to prevent.
 * If a legitimate change drops the real count below a floor, LOWER THE FLOOR
 * DELIBERATELY in a reviewed change; never delete the assertion.
 */
export const MIN_CATALOG_ENTRIES = 10;
export const MIN_PACKAGE_MANIFESTS = 30;

/**
 * A valid npm package name: optional @scope/, lowercase, no path/flow-control
 * characters. Used to reject YAML shapes that merely LOOK like `key: value`.
 */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * A dependency must never be governed by BOTH `catalog:` and a bare `overrides:`
 * entry — a bare override SHADOWS the catalog completely, making the catalog
 * value inert AND unvalidated.
 *
 * Measured, not assumed: with `overrides: react: ^19.2.4` in place, setting
 * `catalog: react: ^19.9.9` (a version that DOES NOT EXIST) still lets
 * `pnpm install` exit 0 and resolve react 19.2.7. Structural confirmation: the
 * lockfile's `catalogs: default:` block omits react/react-dom entirely while
 * listing every other catalogued dep. So an override-shadowed catalog entry is
 * decorative — it can hold any value at all and rots silently the moment
 * someone bumps the override (e.g. for a security fix), with nothing anywhere
 * reporting the divergence.
 *
 * Which mechanism should win is a real decision, not a formality: `overrides`
 * additionally constrains TRANSITIVE dependencies (157 third-party packages
 * depend on react/react-dom directly in this repo) — scope a catalog does not
 * have. For react/react-dom the override is therefore load-bearing (it is what
 * guarantees ONE react instance), so they are deliberately NOT catalogued.
 *
 * SUBTREE-SCOPED overrides (`react-helmet-async>react`) are NOT a conflict: they
 * retarget one dep inside one subtree and leave the catalog governing everywhere
 * else. Only bare, global override keys shadow a catalog entry.
 */

/**
 * The package name a bare override key targets, or `null` if the key is
 * subtree-scoped (`parent>child`) and therefore does not globally shadow.
 *
 * Only `>` denotes subtree scoping. `@` does NOT: it appears in ordinary bare
 * keys both as an npm scope (`@types/node`) and as a version selector
 * (`react@^19`), so keying off `@` would misclassify every scoped package.
 */
export function bareOverrideTarget(key) {
  if (key.includes('>')) {
    return null; // subtree-scoped — narrow, leaves the catalog governing elsewhere
  }
  // Strip an optional trailing version selector, preserving a leading @scope.
  const at = key.lastIndexOf('@');
  const name = at > 0 ? key.slice(0, at) : key;
  return name;
}

/**
 * Parse the default `catalog:` block from pnpm-workspace.yaml.
 *
 * Hand-parsed rather than via the `yaml` package on purpose: `yaml` is a
 * dependency of packages/ui, not the workspace root, and pnpm's strict linking
 * makes it unresolvable from scripts/ — the same reason readWorkspaceGlobs() in
 * package-scripts-canonical-form-contract.test.mjs hand-parses the packages:
 * block. Only the exact block shape this repo writes is supported; anything
 * else throws rather than under-reporting.
 */
export function readCatalogEntries(repoRoot) {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const lines = yaml.split('\n');

  // NO SILENT FALLBACK: named catalogs (`catalogs:`) are a different pnpm
  // feature with a nested shape this parser does not model. If someone adds one,
  // every name inside it would be invisible here and drift freely.
  if (lines.some((line) => /^catalogs:\s*$/.test(line))) {
    throw new Error(
      'pnpm-workspace.yaml declares a named-catalog block (`catalogs:`), which verify-catalog-references.mjs ' +
        'does not model — names inside it would silently escape this guard. Teach readCatalogEntries() the ' +
        'named-catalog shape before using one.'
    );
  }

  const entries = new Map();
  let inCatalog = false;
  for (const rawLine of lines) {
    if (/^catalog:\s*$/.test(rawLine)) {
      inCatalog = true;
      continue;
    }
    if (!inCatalog) {
      continue;
    }
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) {
      continue;
    }
    // A non-indented line ends the block (next top-level key or comment).
    if (/^\S/.test(rawLine)) {
      break;
    }
    const item = rawLine.match(
      /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:'"]+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/
    );
    if (!item) {
      // NO SILENT FALLBACK: an unparseable line inside the block would drop a
      // catalogued name from the checked set and fake a green for it.
      throw new Error(
        'verify-catalog-references.mjs could not parse this line inside the pnpm-workspace.yaml catalog: block:\n' +
          `  ${rawLine}\n` +
          'Only simple `name: version` entries (optionally quoted) are supported. Teach readCatalogEntries() the ' +
          'new shape rather than letting the name escape the guard.'
      );
    }
    const name = item[1] ?? item[2] ?? item[3];
    const version = item[4] ?? item[5] ?? item[6];
    // The line-shape regex alone is too permissive: an unexpected YAML
    // construct (a flow mapping, a nested key, an anchor) can still satisfy
    // `<token>: <token>` and would then be recorded as a bogus catalog entry —
    // silently accepted garbage, which is the same class of hole this guard
    // exists to close. Validate that the key is genuinely an npm package name.
    if (!NPM_NAME_RE.test(name)) {
      throw new Error(
        'verify-catalog-references.mjs could not parse this line inside the pnpm-workspace.yaml catalog: block:\n' +
          `  ${rawLine}\n` +
          `It yielded "${name}", which is not a valid npm package name, so this is not a plain \`name: version\` ` +
          'entry. Only simple entries are supported — teach readCatalogEntries() the new shape rather than letting ' +
          'it be recorded as a bogus catalog name.'
      );
    }
    entries.set(name, version);
  }
  return entries;
}

/**
 * Parse the `overrides:` block from pnpm-workspace.yaml. Same hand-parse
 * rationale and same strictness as readCatalogEntries().
 */
export function readOverrideKeys(repoRoot) {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const keys = [];
  let inOverrides = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^overrides:\s*$/.test(rawLine)) {
      inOverrides = true;
      continue;
    }
    if (!inOverrides) {
      continue;
    }
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) {
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break; // next top-level key ends the block
    }
    const item = rawLine.match(/^\s+(?:'([^']+)'|"([^"]+)"|([^\s:'"]+))\s*:\s*\S.*$/);
    if (!item) {
      // NO SILENT FALLBACK: an unparsed override line could hide a bare override
      // that silently shadows a catalog entry — the exact defect this guards.
      throw new Error(
        'verify-catalog-references.mjs could not parse this line inside the pnpm-workspace.yaml overrides: block:\n' +
          `  ${rawLine}\n` +
          'Teach readOverrideKeys() the new shape rather than letting an override escape the catalog-conflict check.'
      );
    }
    keys.push(item[1] ?? item[2] ?? item[3]);
  }
  return keys;
}

/**
 * Catalogued names that a bare `overrides:` entry silently shadows. A non-empty
 * result means the catalog is lying: those entries do not govern anything.
 */
export function findCatalogOverrideConflicts({ repoRoot }) {
  const catalog = readCatalogEntries(repoRoot);
  const conflicts = [];
  for (const key of readOverrideKeys(repoRoot)) {
    const target = bareOverrideTarget(key);
    if (target !== null && catalog.has(target)) {
      conflicts.push({ catalogVersion: catalog.get(target), name: target, overrideKey: key });
    }
  }
  return conflicts;
}

/**
 * Workspace package globs from pnpm-workspace.yaml (single source of truth), so
 * a newly added group cannot silently escape the "every package" coverage this
 * guard promises.
 */
export function readWorkspaceGlobs(repoRoot) {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = rawLine.match(/^\s+-\s+['"]?([^'"]+?)['"]?\s*$/);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break; // next top-level key ends the packages block
    }
  }
  return globs;
}

/**
 * Absolute paths of every package.json this guard governs: the workspace root
 * manifest (it declares catalogued devDeps too) plus every workspace package.
 */
export function packageManifestPaths(repoRoot) {
  const manifests = [path.join(repoRoot, 'package.json')];
  for (const glob of readWorkspaceGlobs(repoRoot)) {
    const match = glob.match(/^(.+)\/\*$/);
    if (!match) {
      // NO SILENT FALLBACK: an unfamiliar glob shape (pnpm exclusion "!apps/x",
      // recursive "apps/**", …) would under-enumerate and fake a green.
      throw new Error(
        `pnpm-workspace.yaml contains the package glob "${glob}", which verify-catalog-references.mjs does not ` +
          'know how to enumerate (only single-level "<dir>/*" globs are supported). Update packageManifestPaths() ' +
          'before this glob can hide a package.'
      );
    }
    const groupDir = path.join(repoRoot, match[1]);
    let entries;
    try {
      entries = readdirSync(groupDir);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err; // NO SILENT FALLBACK: only a genuinely-absent group dir is skippable
      }
      continue;
    }
    for (const entry of entries) {
      const manifest = path.join(groupDir, entry, 'package.json');
      try {
        if (statSync(manifest).isFile()) {
          manifests.push(manifest);
        }
      } catch {
        // not a package dir
      }
    }
  }
  return [...new Set(manifests)];
}

/** True when `spec` references the default catalog. */
function isDefaultCatalogReference(spec) {
  return spec === 'catalog:' || spec === 'catalog:default';
}

/**
 * Every catalogued dependency referenced with anything other than "catalog:"
 * from a checked field. Returns an array of violation objects (empty = clean).
 */
export function findCatalogViolations({ repoRoot }) {
  const catalog = readCatalogEntries(repoRoot);
  const manifests = packageManifestPaths(repoRoot);

  // Vacuous-pass floors, asserted BEFORE the scan: with an empty catalog or no
  // manifests the loop below finds zero violations and reports success while
  // checking nothing.
  if (catalog.size < MIN_CATALOG_ENTRIES) {
    throw new Error(
      `Refusing to run: found only ${catalog.size} entr(ies) in the pnpm-workspace.yaml catalog: block, below the ` +
        `floor of ${MIN_CATALOG_ENTRIES}. With a near-empty catalog this guard would scan for nothing and report a ` +
        'vacuous green. Either the catalog block was gutted (restore it) or readCatalogEntries() stopped parsing it.'
    );
  }
  if (manifests.length < MIN_PACKAGE_MANIFESTS) {
    throw new Error(
      `Refusing to run: enumerated only ${manifests.length} package.json file(s), below the floor of ` +
        `${MIN_PACKAGE_MANIFESTS}. This guard's promise is "every workspace package"; a near-empty enumeration would ` +
        'iterate zero times and pass vacuously. Usually means pnpm-workspace.yaml stopped parsing, not that 10+ ' +
        'packages were legitimately removed at once.'
    );
  }

  const violations = [];
  for (const manifestPath of manifests) {
    let manifest;
    const raw = readFileSync(manifestPath, 'utf8');
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      // NO SILENT FALLBACK: an unparseable manifest is an unknown state, not a
      // clean one. Skipping it would hide every dep it declares.
      throw new Error(
        `verify-catalog-references.mjs could not parse ${path.relative(repoRoot, manifestPath)}: ${err.message}. ` +
          'A manifest that does not parse cannot be certified catalog-clean; fix the JSON.'
      );
    }
    for (const field of CATALOG_CHECKED_FIELDS) {
      const deps = manifest[field];
      if (deps === undefined) {
        continue;
      }
      for (const [name, spec] of Object.entries(deps)) {
        if (!catalog.has(name) || isDefaultCatalogReference(spec)) {
          continue;
        }
        violations.push({
          catalogVersion: catalog.get(name),
          field,
          manifest: path.relative(repoRoot, manifestPath),
          name,
          spec,
        });
      }
    }
  }
  return violations;
}

/** Human-readable violation report used by the test's assertion message. */
export function formatViolations(violations) {
  return violations
    .map(
      (v) =>
        `${v.manifest} [${v.field}] declares "${v.name}": "${v.spec}" but ${v.name} is catalogued in ` +
        `pnpm-workspace.yaml as "${v.catalogVersion}". Use "catalog:" instead — a literal here is silently accepted ` +
        `by pnpm install and resolves a SECOND parallel version of ${v.name}. If the version must change, bump the ` +
        'catalog entry.'
    )
    .join('\n');
}
