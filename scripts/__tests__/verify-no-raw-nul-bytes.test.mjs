import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findRawNulByteViolations,
  GUARDED_EXTENSIONS,
  MIN_SCANNED_FILES,
  PATHSPECS,
} from '../verify-no-raw-nul-bytes.mjs';

// A raw 0x00 written as a two-character escape, so THIS file stays clean under
// the very guard it exercises. `'\0'` and a literal NUL byte are identical at
// runtime — that equivalence is the whole reason the fix is safe, and the
// "escaped NUL is not a violation" control below pins it.
const NUL = '\0';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  const { violations } = findRawNulByteViolations();

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
// A bare total floor only catches TOTAL enumeration failure. Dropping 'scripts'
// from PATHSPECS still returns ~4050 of 4172 files and sails past any global
// threshold, leaving the guard permanently blind to the directory it lives in —
// which is exactly how verify-no-source-cycles.mjs kept its NUL. So the floors
// are per-slice, and each expectation map is asserted EXHAUSTIVE against the
// guard's own constants: adding an extension or pathspec forces whoever adds it
// to state what they expect to find, instead of the map quietly falling behind.
//
// Numbers are set at roughly half of today's counts — loose enough that ordinary
// churn never trips them, tight enough that a dropped slice cannot hide.
// ---------------------------------------------------------------------------

// apps 831 / packages 3221 / scripts 120 as of 2026-08-09.
const MIN_FILES_PER_PATHSPEC = { apps: 400, packages: 1500, scripts: 60 };

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
  const { scannedFiles } = findRawNulByteViolations();

  assert.ok(
    scannedFiles.length >= MIN_SCANNED_FILES,
    `Scanned only ${scannedFiles.length} source file(s), below the floor of ${MIN_SCANNED_FILES}. ` +
      'Either the git pathspec / extension filter broke (fix that, not this number) or the ' +
      'repo shrank drastically, in which case every assertion in this file is vacuously green.'
  );
});

test('sentinel: every pathspec contributes files, so none can be silently dropped', () => {
  const { scannedFiles } = findRawNulByteViolations();

  assert.deepEqual(
    Object.keys(MIN_FILES_PER_PATHSPEC).sort(),
    [...PATHSPECS].sort(),
    "MIN_FILES_PER_PATHSPEC has drifted from the guard's PATHSPECS. Add the new pathspec here " +
      'with an expected floor rather than deleting this assertion.'
  );

  const counts = Object.fromEntries(
    Object.keys(MIN_FILES_PER_PATHSPEC).map((pathspec) => [
      pathspec,
      scannedFiles.filter((filePath) => filePath.startsWith(`${pathspec}/`)).length,
    ])
  );
  const starved = Object.entries(counts).filter(
    ([pathspec, count]) => count < MIN_FILES_PER_PATHSPEC[pathspec]
  );

  assert.deepEqual(
    starved,
    [],
    'These pathspecs returned far fewer files than expected, so the guard is blind to them:\n' +
      starved
        .map(([p, c]) => `  - ${p}: scanned ${c}, expected at least ${MIN_FILES_PER_PATHSPEC[p]}`)
        .join('\n')
  );
});

test('sentinel: every guarded extension is actually reached in the real tree', () => {
  const { scannedFiles } = findRawNulByteViolations();

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
  const { scannedFiles } = findRawNulByteViolations();
  const testFile = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
  const guardFile = path.join(path.dirname(path.dirname(testFile)), 'verify-no-raw-nul-bytes.mjs');

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
