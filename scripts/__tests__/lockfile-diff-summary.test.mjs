import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitPackageKey, summarizeLockfileDiff } from '../lockfile-diff-summary.mjs';

const code = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 2;
 const b = 3;
`;

// Real lockfile entries carry several detail lines each; that ratio is where the
// compression comes from, so fixtures that are all headers would not represent it.
function entry(sign, name, version) {
  return [
    `${sign}  ${name}@${version}:`,
    `${sign}    resolution: {integrity: sha512-${name.replace(/\W/g, '')}${version.replace(/\W/g, '')}==}`,
    `${sign}    engines: {node: '>=18'}`,
    `${sign}    peerDependencies:`,
    `${sign}      react: ^19.0.0`,
  ].join('\n');
}

function lockfile(body) {
  return `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 3333333..4444444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,10 +1,10 @@
${body}`;
}

test('a peer suffix does not steal the version, and unversioned keys are ignored', () => {
  // lastIndexOf('@') over the whole key reads the peer's version as the
  // package's. That has produced a false green in this repository before.
  assert.deepEqual(splitPackageKey('@codemirror/view@6.1.0(@codemirror/state@6.5.2)'), {
    name: '@codemirror/view',
    version: '6.1.0',
  });
  assert.deepEqual(splitPackageKey('vite@7.1.5'), { name: 'vite', version: '7.1.5' });
  assert.deepEqual(splitPackageKey('@scope/pkg@1.0.0'), { name: '@scope/pkg', version: '1.0.0' });
  // Importer paths and bare scopes carry no version and must not be reported.
  assert.equal(splitPackageKey('apps/web'), null);
  assert.equal(splitPackageKey('@scope/pkg'), null);
  assert.equal(splitPackageKey('trailing@'), null);
});

test('every non-lockfile byte survives untouched', () => {
  const diff = `${code}${lockfile(
    Array.from({ length: 60 }, (_, index) => `-  pkg-${index}@1.0.0:\n+  pkg-${index}@2.0.0:`).join(
      '\n'
    )
  )}\n${code.replace('src/app.ts', 'src/other.ts')}`;
  const { diff: out, replacements } = summarizeLockfileDiff(diff);
  assert.equal(replacements.length, 1);
  assert.ok(out.includes(code), 'the leading code section must be byte-identical');
  assert.ok(
    out.includes(code.replace('src/app.ts', 'src/other.ts')),
    'a code section after the lockfile must be byte-identical'
  );
  assert.ok(!out.includes('pkg-59@2.0.0:'), 'lockfile hunks must not survive');
  assert.match(out, /pkg-59: 1\.0\.0 -> 2\.0\.0/);
  assert.ok(Buffer.byteLength(out) < Buffer.byteLength(diff));
});

test('duplicate resolutions and non-registry sources are named, not merely counted', () => {
  const { diff: out } = summarizeLockfileDiff(
    lockfile(
      [
        "+  '@codemirror/state@6.5.2':",
        '+    resolution: {integrity: sha512-aaa==}',
        "+  '@codemirror/state@6.4.1(x@1.0.0)':",
        '+    resolution: {integrity: sha512-bbb==}',
        '+  sketchy@1.0.0:',
        '+    resolution: {tarball: https://example.invalid/sketchy.tgz}',
        ...Array.from({ length: 40 }, (_, index) => entry('-', `filler-${index}`, '1.0.0')),
      ].join('\n')
    )
  );
  assert.match(out, /packages on more than one version among the entries this diff ADDS: 1/);
  assert.match(out, /@codemirror\/state: 6\.4\.1, 6\.5\.2/);
  assert.match(out, /non-registry resolutions introduced: 1/);
  assert.match(out, /tarball: https:\/\/example\.invalid\/sketchy\.tgz/);
  // The lower-bound caveat must travel with the count, since a version this diff
  // leaves untouched cannot appear in it.
  assert.match(out, /lower bound/);
});

test('a lockfile change smaller than its own summary keeps its exact hunks', () => {
  const tiny = lockfile('-  vite@7.1.4:\n+  vite@7.1.5:');
  const { diff: out, replacements } = summarizeLockfileDiff(tiny);
  assert.deepEqual(replacements, []);
  assert.equal(out, tiny);
});

test('a nested lockfile is matched by name and an unparsable header is left alone', () => {
  const nested = `diff --git a/packages/x/pnpm-lock.yaml b/packages/x/pnpm-lock.yaml
@@ -1,4 +1,4 @@
${Array.from({ length: 40 }, (_, index) => `${entry('-', `dep-${index}`, '1.0.0')}\n${entry('+', `dep-${index}`, '2.0.0')}`).join('\n')}
`;
  const { replacements } = summarizeLockfileDiff(nested);
  assert.deepEqual(
    replacements.map((entry) => entry.path),
    ['packages/x/pnpm-lock.yaml']
  );
  // A header this cannot parse must fall through as "not summarized" rather
  // than be summarized against the wrong path.
  const spaced = 'diff --git a/a file.txt b/a file.txt\n@@ -1 +1 @@\n-x\n+y\n';
  assert.deepEqual(summarizeLockfileDiff(spaced), { diff: spaced, replacements: [] });
});

test('a path merely containing the lockfile name is matched by basename, not substring', () => {
  // Large enough that the size-regression guard cannot mask the decision: if the
  // match were a substring test, this file would be summarized and the guard
  // would not save it.
  const decoy = `diff --git a/docs/pnpm-lock.yaml.md b/docs/pnpm-lock.yaml.md
@@ -1,4 +1,4 @@
${Array.from({ length: 40 }, (_, index) => `${entry('-', `dep-${index}`, '1.0.0')}\n${entry('+', `dep-${index}`, '2.0.0')}`).join('\n')}
`;
  assert.deepEqual(summarizeLockfileDiff(decoy), { diff: decoy, replacements: [] });
});
