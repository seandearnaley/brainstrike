import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findRawNulByteViolations,
  GUARDED_EXTENSIONS,
  MIN_SCANNED_FILES,
} from '../verify-no-raw-nul-bytes.mjs';

// A raw 0x00 written as a two-character escape, so THIS file stays clean under
// the very guard it exercises. `'\0'` and a literal NUL byte are identical at
// runtime — that equivalence is the whole reason the fix is safe, and the
// "escaped NUL is not a violation" control below pins it.
const NUL = '\0';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// `git ls-files` always emits POSIX separators; `path.*` emits `\` on win32.
// Comparing the two directly passes on macOS/Linux and fails on Windows with a
// misleading "enumeration broke" message (PR #2379 review). Same idiom as
// mastra-boundary-contract.test.mjs:144 and its siblings.
const toPosix = (value) => value.split(path.sep).join('/');

// The real-tree scan is identical across every argument-less call, but each one
// re-spawns git and re-reads ~4.2k files. Memoized so `pnpm test:scripts` pays
// for one scan instead of six. Fixture-rooted calls stay per-test.
let realTreeScan;
const scanRealTree = () => {
  realTreeScan ??= findRawNulByteViolations();
  return realTreeScan;
};

function writeFixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'raw-nul-guard-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  // The guard enumerates TRACKED files, so a fixture must be a real index —
  // scanning the working tree instead would let node_modules and build output
  // back in, and would not match what the guard actually promises.
  for (const args of [
    ['init', '-q', '.'],
    ['add', '-A'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return root;
}

// The real verdict. Before the BST fix this failed with four files; a raw NUL is
// invisible to grep/git grep (both treat the file as binary and skip it), so
// this assertion is the only thing that can see the debt at all.
test('real tree: no tracked source file contains a raw 0x00 byte', () => {
  const { violations } = scanRealTree();

  assert.deepEqual(
    violations,
    [],
    'These tracked source files contain raw NUL bytes. Replace each one with the ' +
      'two-character escape `\\0` — identical at runtime, but greppable:\n' +
      violations.map((v) => `  - ${v.filePath}:${v.lineNumbers.join(',')}`).join('\n')
  );
});

// ---------------------------------------------------------------------------
// Discovery sentinels.
//
// A bare total floor only catches TOTAL enumeration failure. Re-introducing a
// directory restriction that drops 'scripts' would still return ~4070 of 4192
// files and sail past any global threshold, leaving the guard permanently blind
// to the directory it lives in — which is exactly how verify-no-source-cycles.mjs
// kept its NUL. So the floors are per-slice.
//
// Numbers are set at roughly half of today's counts — loose enough that ordinary
// churn never trips them, tight enough that a dropped slice cannot hide.
// ---------------------------------------------------------------------------

// Top-level areas, '' meaning repo-root files. These are NOT derived from a
// guard constant, because the guard deliberately has no directory list any more
// (PR #2379 review): it enumerates every tracked file and filters by extension.
// So this map pins the stronger property — that the scan really is repo-wide,
// reaching root config and non-workspace trees, not just the three workspace
// directories an earlier revision hard-coded.
// root 5 / apps 831 / packages 3221 / scripts 122 / spikes 15 as of 2026-08-09.
const MIN_FILES_PER_AREA = { '': 4, apps: 400, packages: 1500, scripts: 60, spikes: 8 };

const areaOf = (filePath) => (filePath.includes('/') ? filePath.split('/')[0] : '');

// .ts 3107 / .tsx 833 / .mjs 140 / .mts 63 / .js 18 / .cjs 11 as of 2026-08-09.
// `.cts` is deliberately 0: no tracked file uses it today, but it stays guarded
// so a .cts added tomorrow is covered from the start. The fixture control
// 'covers each guarded ... extension' is what proves that wiring works.
const MIN_FILES_PER_EXTENSION = {
  '.cjs': 5,
  '.cts': 0,
  '.js': 10,
  '.mjs': 60,
  '.mts': 30,
  '.ts': 1500,
  '.tsx': 400,
};

test('discovery floor: the scanned source set is not silently empty', () => {
  const { scannedFiles } = scanRealTree();

  assert.ok(
    scannedFiles.length >= MIN_SCANNED_FILES,
    `Scanned only ${scannedFiles.length} source file(s), below the floor of ${MIN_SCANNED_FILES}. ` +
      'Either the git pathspec / extension filter broke (fix that, not this number) or the ' +
      'repo shrank drastically, in which case every assertion in this file is vacuously green.'
  );
});

test('sentinel: the scan is repo-wide, reaching root config and non-workspace trees', () => {
  const { scannedFiles } = scanRealTree();

  const starved = Object.entries(MIN_FILES_PER_AREA)
    .map(([area, minimum]) => ({
      area: area || '<repo root>',
      count: scannedFiles.filter((filePath) => areaOf(filePath) === area).length,
      minimum,
    }))
    .filter(({ count, minimum }) => count < minimum);

  assert.deepEqual(
    starved,
    [],
    'These areas returned far fewer files than expected, so the guard is blind to them. A ' +
      'directory allowlist was most likely re-introduced into the enumeration:\n' +
      starved.map((s) => `  - ${s.area}: scanned ${s.count}, expected ${s.minimum}`).join('\n')
  );
});

// Named files, because the counts above would still pass if root config were
// swept in by accident while these specific live configs were missed. These are
// the exact paths the PR #2379 review called out as escaping the old pathspecs.
test('sentinel: live root config and spikes sources are in scope', () => {
  const { scannedFiles } = scanRealTree();

  const missing = [
    'commitlint.config.ts',
    'eslint.config.js',
    'vitest.config.mts',
    'spikes/quickjs-sandbox/src/quickjs-sandbox.ts',
  ].filter((filePath) => !scannedFiles.includes(filePath));

  assert.deepEqual(
    missing,
    [],
    'These tracked sources are not being scanned. A raw NUL in any of them would pass the ' +
      'guard while causing the same search/tooling breakage:\n' +
      missing.map((f) => `  - ${f}`).join('\n')
  );
});

test('sentinel: every guarded extension is actually reached in the real tree', () => {
  const { scannedFiles } = scanRealTree();

  assert.deepEqual(
    Object.keys(MIN_FILES_PER_EXTENSION).sort(),
    [...GUARDED_EXTENSIONS].sort(),
    "MIN_FILES_PER_EXTENSION has drifted from the guard's GUARDED_EXTENSIONS. Add the new " +
      'extension here with an expected floor rather than deleting this assertion.'
  );

  const starved = Object.entries(MIN_FILES_PER_EXTENSION)
    .map(([extension, minimum]) => ({
      count: scannedFiles.filter((filePath) => path.extname(filePath) === extension).length,
      extension,
      minimum,
    }))
    .filter(({ count, minimum }) => count < minimum);

  assert.deepEqual(
    starved,
    [],
    'These extensions returned fewer files than expected — the filter likely lost one:\n' +
      starved.map((s) => `  - ${s.extension}: scanned ${s.count}, expected ${s.minimum}`).join('\n')
  );
});

// The one filename sentinel worth having, and it cannot rot: derived from this
// test's own location rather than hardcoded, so it follows any rename. It pins
// the property no count can — that the scan actually reaches the guard's own
// source, the blind spot that let a NUL sit in scripts/ unnoticed.
test('sentinel: the guard scans its own source and this test file', () => {
  const { scannedFiles } = scanRealTree();
  const testFile = toPosix(path.relative(REPO_ROOT, fileURLToPath(import.meta.url)));
  const guardFile = path.posix.join(
    path.posix.dirname(path.posix.dirname(testFile)),
    'verify-no-raw-nul-bytes.mjs'
  );

  for (const expected of [testFile, guardFile]) {
    assert.ok(
      scannedFiles.includes(expected),
      `${expected} is not in the scanned set. Either it is not tracked yet (git add it — the ` +
        'guard only ever sees tracked files, by design), or the scripts/ pathspec broke and the ' +
        'guard has gone blind to its own directory.'
    );
  }
});

// CONTROL: the check can actually fail. Without this, a detector that always
// returns [] is indistinguishable from a clean tree.
test('control: flags a raw NUL byte and reports every line holding one', () => {
  const root = writeFixture({
    'packages/example/src/dirty.ts': `const a = 'x${NUL}y';\nconst clean = 1;\nconst b = \`p${NUL}q\`;\n`,
  });

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, [
    { count: 2, filePath: 'packages/example/src/dirty.ts', lineNumbers: [1, 3] },
  ]);
});

// CONTROL: multiple NULs on one line collapse to a single line number but keep an
// honest total — threads-panel-dnd.ts had exactly this shape (4 NULs, 2 lines).
test('control: de-duplicates line numbers without under-counting occurrences', () => {
  const root = writeFixture({
    'packages/example/src/pair.ts': `if (a.join('${NUL}') === b.join('${NUL}')) {\n}\n`,
  });

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, [
    { count: 2, filePath: 'packages/example/src/pair.ts', lineNumbers: [1] },
  ]);
});

// CONTROL: this is what the fix produces. If the guard flagged `\0` too, the
// remediation it demands would not satisfy it — and the two intentional
// NUL-handling fixtures (live-grep, fence-escape-resistance) could not be kept.
test('control: an escaped \\0 is not a violation', () => {
  const root = writeFixture({
    'packages/example/src/fixed.ts': "const a = 'x\\0y';\nconst b = ['p', 'q'].join('\\0');\n",
  });

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, []);
});

// CONTROL: binary assets are tracked and legitimately full of NULs (icon.png
// alone holds 31k). Scoping by extension rather than by content is what keeps
// them out — a naive "any tracked file" scan would drown in them.
test('control: tracked binary assets are out of scope', () => {
  const root = writeFixture({
    'packages/example/icons/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a]),
    'packages/example/src/notes.md': `prose mentioning a ${NUL} byte\n`,
  });

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, []);
});

// CONTROL: `git ls-files` reports cached entries, so a tracked file deleted from
// the working tree without staging the deletion — an ordinary mid-edit state —
// stays in the enumeration with nothing on disk to read. Before PR #2379 review
// that aborted the whole lint run with ENOENT. There is no content to scan, so
// it is excluded; any OTHER read failure still throws rather than degrading.
test('control: a tracked file deleted from the working tree is skipped, not fatal', () => {
  const root = writeFixture({
    'packages/example/src/gone.ts': 'const bye = 1;\n',
    'packages/example/src/kept.ts': 'const ok = 1;\n',
  });
  rmSync(path.join(root, 'packages/example/src/gone.ts'));

  const { scannedFiles, violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, []);
  assert.ok(
    scannedFiles.includes('packages/example/src/kept.ts'),
    'the surviving file must still be scanned'
  );
  assert.ok(
    !scannedFiles.includes('packages/example/src/gone.ts'),
    'a tracked file missing from the working tree has no content to scan and must be excluded'
  );
});

// CONTROL: untracked files are not the guard's business — a scratch file in the
// working tree must not fail a lane that is meant to gate what lands in git.
test('control: untracked files are ignored', () => {
  const root = writeFixture({
    'packages/example/src/tracked.ts': 'const ok = 1;\n',
  });
  writeFileSync(path.join(root, 'packages/example/src/scratch.ts'), `const bad = '${NUL}';\n`);

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(violations, []);
});

// CONTROL: every guarded extension is actually wired up. A typo in the extension
// set would silently exempt a whole language surface.
test('control: covers each guarded TypeScript and JavaScript extension', () => {
  const extensions = ['cjs', 'cts', 'js', 'mjs', 'mts', 'ts', 'tsx'];
  const root = writeFixture(
    Object.fromEntries(
      extensions.map((ext) => [`packages/example/src/file-${ext}.${ext}`, `const a = '${NUL}';\n`])
    )
  );

  const { violations } = findRawNulByteViolations({ root });

  assert.deepEqual(
    violations.map((v) => v.filePath),
    extensions.map((ext) => `packages/example/src/file-${ext}.${ext}`)
  );
});

test('refuses to report a clean tree when enumeration finds nothing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'raw-nul-guard-empty-'));

  assert.throws(
    () => findRawNulByteViolations({ root }),
    /git ls-files/,
    'A root the guard cannot enumerate must throw, not return zero violations.'
  );
});
