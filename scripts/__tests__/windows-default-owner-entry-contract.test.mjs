import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NODE_BUILDS } from '../../apps/desktop/scripts/build-main-config.mjs';

/*
 * BST-2246 (owner decision A1). On Windows, an elevated token's default owner
 * for new objects is BUILTIN\Administrators. host-lease refuses a data root
 * owned by anyone but the user, so every process that can create host-lease or
 * state-store objects makes the user its default owner before it creates
 * anything. That setting belongs to the process, so each such entry imports
 * `@brainstrike/secure-fs-native/default-owner` as its first statement. ES
 * modules evaluate imports in order, so that runs before any later import or call.
 *
 * Every Windows-capable process entry is classified below. A new entry fails
 * this contract until it is classified, so none escapes it unreviewed.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OWNER = '@brainstrike/secure-fs-native/default-owner';

/** Entries that can create host-lease or state-store objects. */
const STATE_ENTRIES = new Map([
  [
    'apps/desktop/src/main-bootstrap.ts',
    'Electron Main: userData, logs, session data and the profile reset lease',
  ],
  ['apps/desktop/src/host-lease-entry.ts', 'utility host: data root, lock and host record'],
  ['apps/desktop/src/agent-host-entry.ts', 'utility agent host: data root, lock, record and store'],
  ['apps/desktop/src/indexer-host-entry.ts', 'utility indexer: writes the index database'],
  ['packages/host-lease/src/process-entry.ts', 'Node host: data root, lock and host record'],
  ['packages/agent-host/src/host-process-entry.ts', 'Node agent host the CLI starts'],
  ['packages/indexer/src/process-entry.ts', 'Node indexer: writes the index database'],
]);

/** Entries that create no host-lease or state-store object, and why. */
const EXEMPT_ENTRIES = new Map([
  ['apps/desktop/src/agent-egress-entry.ts', 'network egress for agent browsing; writes no files'],
  [
    'apps/desktop/src/agent-host-platform-entry.ts',
    'a module the agent host process loads, not a process entry',
  ],
  ['apps/desktop/src/desktop-bootstrap-runtime.ts', 'a module Main loads, not a process entry'],
  ['apps/desktop/src/desktop-database-location.ts', 'a module Main loads, not a process entry'],
  ['apps/desktop/src/desktop-env.ts', 'a module Main loads, not a process entry'],
  ['apps/desktop/src/desktop-shutdown-state.ts', 'a module Main loads, not a process entry'],
  [
    'apps/desktop/src/diagnostics/main-log-transport.ts',
    "a worker thread in Main's process, which shares Main's token",
  ],
  [
    'apps/desktop/src/diagnostics/main-watchdog-worker.ts',
    "a worker thread in Main's process, which shares Main's token",
  ],
  ['apps/desktop/src/hidden-preload.ts', 'a renderer preload; creates no files'],
  ['apps/desktop/src/main.ts', 'a module Main loads after main-bootstrap, not a process entry'],
  [
    'apps/desktop/src/official-conformance-client-entry.ts',
    'an MCP conformance test client; creates no host-lease or state objects',
  ],
  ['apps/desktop/src/parser-host-entry.ts', 'parses source text; writes no files'],
  ['apps/desktop/src/preload.ts', 'a renderer preload; creates no files'],
  ['apps/desktop/src/sqlite-query-host-entry.ts', 'opens the index database read-only'],
  [
    'apps/desktop/src/windows-command-entry.ts',
    "runs a user's command in a kill-on-close Job; creates no Brainstrike state",
  ],
  [
    'packages/agent-host/src/process-entry.ts',
    'the module host-process-entry.ts loads, not the forked entry itself',
  ],
  [
    'packages/embeddings/bin/embed-code.js',
    'a developer embedding CLI; creates no host-lease or state objects',
  ],
  [
    'packages/host-capabilities/bin/brainstrike.mjs',
    'the CLI launches and attaches only; the agent host it starts is a state entry',
  ],
]);

/** Desktop entries from the Node builds themselves, plus Node process entries and package bins. */
function discoveredEntries() {
  const found = new Set();
  for (const build of NODE_BUILDS) {
    for (const entry of Object.values(build.entryPoints)) {
      found.add(`apps/desktop/${entry}`);
    }
  }
  for (const name of readdirSync(path.join(repoRoot, 'packages'))) {
    const src = path.join(repoRoot, 'packages', name, 'src');
    if (existsSync(src)) {
      for (const file of readdirSync(src)) {
        if (/process-entry\.[cm]?ts$/u.test(file)) {
          found.add(`packages/${name}/src/${file}`);
        }
      }
    }
    const manifest = path.join(repoRoot, 'packages', name, 'package.json');
    if (existsSync(manifest)) {
      const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {};
      for (const target of typeof bin === 'string' ? [bin] : Object.values(bin)) {
        found.add(path.posix.join('packages', name, target));
      }
    }
  }
  return [...found].sort();
}

/** Whether the module's first statement is the side-effect import of the default-owner module. */
export function importsDefaultOwnerFirst(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true);
  const first = source.statements[0];
  return Boolean(
    first &&
      ts.isImportDeclaration(first) &&
      first.importClause === undefined &&
      ts.isStringLiteral(first.moduleSpecifier) &&
      first.moduleSpecifier.text === DEFAULT_OWNER
  );
}

test('every discovered process entry is classified, and every classified entry exists', () => {
  const classified = new Set([...STATE_ENTRIES.keys(), ...EXEMPT_ENTRIES.keys()]);
  const discovered = discoveredEntries();
  assert.ok(discovered.length > 0, 'no process entries discovered');
  assert.deepEqual(
    discovered.filter((entry) => !classified.has(entry)),
    [],
    'Classify each new process entry in STATE_ENTRIES (it must import the default owner first) or ' +
      'EXEMPT_ENTRIES (with the reason it creates no host-lease or state-store object).'
  );
  for (const entry of classified) {
    assert.ok(existsSync(path.join(repoRoot, entry)), `${entry} no longer exists`);
  }
});

test('every state-creating entry sets the user as default owner before anything else', () => {
  const missing = [...STATE_ENTRIES.keys()].filter(
    (entry) => !importsDefaultOwnerFirst(readFileSync(path.join(repoRoot, entry), 'utf8'), entry)
  );
  assert.deepEqual(
    missing,
    [],
    `Each entry's first statement must be \`import '${DEFAULT_OWNER}';\` (BST-2246)`
  );
});

test('CONTROL: dropping or moving the import in any state entry FAILS the contract', () => {
  for (const entry of STATE_ENTRIES.keys()) {
    const source = readFileSync(path.join(repoRoot, entry), 'utf8');
    const line = `import '${DEFAULT_OWNER}';\n`;
    assert.ok(source.includes(line), `${entry} has no default-owner import to mutate`);
    const dropped = source.replace(line, '');
    assert.equal(importsDefaultOwnerFirst(dropped, entry), false, `${entry} without the import`);
    const moved = `import 'node:path';\n${dropped.replace(/^((?:\/\/.*\n)*)/u, `$1${line}`)}`;
    assert.equal(importsDefaultOwnerFirst(moved, entry), false, `${entry} with the import second`);
  }
});
