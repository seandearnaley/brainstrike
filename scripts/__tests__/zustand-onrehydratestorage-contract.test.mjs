import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * BST-1645 (same bug class as BST-423 / #2086).
 *
 * Every persisted store in this repo reads through SYNCHRONOUS storage
 * (`createSafeJsonStateStorage` and friends). zustand's persist middleware
 * therefore resolves `hydrate()` inside `create(...)`, and fires
 * `onRehydrateStorage`'s returned callback while the module-level
 * `export const useXStore = ...` binding is still in its temporal dead zone.
 *
 * A callback that reaches for its own store binding throws a `ReferenceError`
 * that zustand's `.catch` swallows — it re-invokes the callback as
 * `(undefined, error)` — so the logic silently never runs on the app's real
 * hydration path. Store tests that call `persist.rehydrate()` after module load
 * cannot see it.
 *
 * The rule: hydration-time repair, normalization and hydration flags belong in
 * `merge`, which needs no module binding and runs on EVERY hydration (including
 * the version-matched case where `migrate` never runs).
 *
 * Each surviving `onRehydrateStorage` site is listed below with the reason it is
 * provably safe. Adding a new one is a deliberate act: extend this list with a
 * reason, or move the logic to `merge`.
 */
const ALLOWLIST = new Map([
  [
    'packages/app-state/src/stores/import-settings-store.ts',
    'Touches only `useTokenPreferencesStore` — a DIFFERENT store binding, ' +
      'imported at module top and already initialized by the time this module ' +
      'evaluates. The chunk-settings repair lives in `merge` (BST-423).',
  ],
  [
    'packages/app-state/src/stores/vector-preferences-store.ts',
    'Writes only the module-scoped `let lastRehydrationError` binding, which is ' +
      'declared above `create(...)` and is therefore initialized. Never touches ' +
      '`useVectorPreferencesStore`.',
  ],
  [
    'packages/file-explorer/src/persistence/file-explorer-persistence.ts',
    'Uses the `preHydrationState` argument zustand passes in, plus module-scoped ' +
      'flags and a logger. Never reaches for a store binding.',
  ],
  ['packages/storage/src/types.ts', 'A type declaration on `PersistConfig`, not a call site.'],
]);

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Blank out comments (newlines preserved so line numbers survive) so a doc
 * comment explaining WHY a store no longer uses `onRehydrateStorage` does not
 * register as a use of it. String literals are tracked only well enough to keep
 * a `//` inside a URL from eating the rest of the line.
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let scan = index; scan < stop; scan += 1) {
        if (source[scan] === '\n') {
          out += '\n';
        }
      }
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        out += inner;
        index += 1;
        if (inner === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (inner === quote) {
          break;
        }
      }
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

function isTestPath(relativePath) {
  return (
    relativePath.includes('/__tests__/') ||
    /\.(?:test|spec|integration\.test)\.[cm]?tsx?$/.test(relativePath)
  );
}

async function collectSourceFiles(absoluteDir, relativeDir, out) {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectSourceFiles(path.join(absoluteDir, entry.name), relativePath, out);
      continue;
    }
    if (!(entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)))) {
      continue;
    }
    if (isTestPath(relativePath)) {
      continue;
    }
    out.push(relativePath);
  }
  return out;
}

async function findOnRehydrateStorageSites(root = REPO_ROOT) {
  const packagesDir = path.join(root, 'packages');
  const packageNames = (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name);

  const files = [];
  for (const packageName of packageNames) {
    await collectSourceFiles(
      path.join(packagesDir, packageName, 'src'),
      `packages/${packageName}/src`,
      files
    );
  }

  const sites = [];
  for (const relativePath of files) {
    const contents = stripComments(await readFile(path.join(root, relativePath), 'utf8'));
    if (contents.includes('onRehydrateStorage')) {
      sites.push(relativePath);
    }
  }
  return sites.sort();
}

test('every onRehydrateStorage site in packages/**/src is on the reviewed allowlist', async () => {
  const sites = await findOnRehydrateStorageSites();
  const allowed = [...ALLOWLIST.keys()].sort();

  const unreviewed = sites.filter((site) => !ALLOWLIST.has(site));
  assert.deepEqual(
    unreviewed,
    [],
    'New onRehydrateStorage site(s). For synchronous storage this callback runs during ' +
      'create(...) while the store binding is in its temporal dead zone, and zustand swallows ' +
      'the ReferenceError. Move the logic to `merge`, or add the file here with a reason:\n' +
      unreviewed.map((site) => `  - ${site}`).join('\n')
  );

  const stale = allowed.filter((site) => !sites.includes(site));
  assert.deepEqual(
    stale,
    [],
    'Allowlist entries with no matching source site — delete them:\n' +
      stale.map((site) => `  - ${site}`).join('\n')
  );
});

/**
 * Names of the module's OWN store bindings that its `onRehydrateStorage`
 * callback reaches for. Non-empty means the TDZ bug is live.
 */
function findOwnBindingViolations(rawSource) {
  const source = stripComments(rawSource);
  const ownBindings = [...source.matchAll(/export const (use\w*Store)\b/g)].map(
    (match) => match[1]
  );
  if (ownBindings.length === 0) {
    return [];
  }

  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^\s*onRehydrateStorage:/.test(line));
  if (start === -1) {
    return [];
  }
  // The callback ends at the next persist option key at the same indentation.
  const indent = /^(\s*)/.exec(lines[start])[1];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^${indent}[a-zA-Z]\\w*:`).test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n');

  return ownBindings.filter((binding) => body.includes(`${binding}.`));
}

test('no allowlisted onRehydrateStorage callback touches its own store binding', async () => {
  const offenders = [];

  for (const relativePath of ALLOWLIST.keys()) {
    const source = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    for (const binding of findOwnBindingViolations(source)) {
      offenders.push(`${relativePath} — onRehydrateStorage reaches for \`${binding}\``);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'An onRehydrateStorage callback touches its own store binding, which is in its temporal ' +
      'dead zone during create(...) for synchronous storage. Move the logic to `merge`:\n' +
      offenders.map((offender) => `  - ${offender}`).join('\n')
  );
});

// The guard has to be able to FAIL. These pin both halves against fixtures.

const OFFENDING_STORE = `export const useThingStore = create()(
  persist(
    (set) => ({ hasHydrated: false }),
    {
      name: 'thing.v1',
      onRehydrateStorage: () => (state, error) => {
        if (!error) {
          useThingStore.setState({ hasHydrated: true });
        }
      },
      storage,
    }
  )
);
`;

const COMPLIANT_STORE = `export const useThingStore = create()(
  persist(
    (set) => ({ hasHydrated: false }),
    {
      merge: (persisted, current) => ({ ...current, ...persisted, hasHydrated: true }),
      name: 'thing.v1',
      storage,
    }
  )
);
`;

test('flags a callback that reaches for its own store binding', () => {
  assert.deepEqual(findOwnBindingViolations(OFFENDING_STORE), ['useThingStore']);
});

test('accepts a store that does the same work in merge', () => {
  assert.deepEqual(findOwnBindingViolations(COMPLIANT_STORE), []);
});

test('ignores an onRehydrateStorage mentioned only in a comment', () => {
  const documented = `/**\n * hasHydrated is set in merge, NOT onRehydrateStorage.\n */\n${COMPLIANT_STORE}`;
  assert.deepEqual(findOwnBindingViolations(documented), []);
});

test('the repo scan finds a newly added onRehydrateStorage site', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zustand-rehydrate-guard-'));
  try {
    const relativePath = 'packages/example/src/stores/thing-store.ts';
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, OFFENDING_STORE);
    // A test file with the same content must NOT count as a site.
    const testFile = path.join(root, 'packages/example/src/__tests__/thing-store.test.ts');
    await mkdir(path.dirname(testFile), { recursive: true });
    await writeFile(testFile, OFFENDING_STORE);

    assert.deepEqual(await findOnRehydrateStorageSites(root), [relativePath]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('the repo scan ignores a store whose only mention is a comment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zustand-rehydrate-guard-'));
  try {
    const full = path.join(root, 'packages/example/src/stores/thing-store.ts');
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(
      full,
      `// hasHydrated is set in merge, NOT onRehydrateStorage.\n${COMPLIANT_STORE}`
    );

    assert.deepEqual(await findOnRehydrateStorageSites(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
