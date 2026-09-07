import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectEdges, splitPackageKey, summarizeLockfileDiff } from '../lockfile-diff-summary.mjs';

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

function lockfileHunks(...hunks) {
  return `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 3333333..4444444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
${hunks.join('\n')}`;
}

function lockfile(body) {
  return lockfileHunks(`@@ -1,10 +1,10 @@ packages:\n${body}`);
}

// A hunk as `gh pr diff` emits it. git's funcname trailer names the nearest
// preceding column-0 line, which in a pnpm lockfile is always the section
// marker: all ten hunks of #3053 carried `packages:` or `snapshots:`. That
// trailer is the only thing that identifies the section, because a block key
// four or more lines above a changed dependency falls outside -U3 context.
function hunk(trailer, ...body) {
  return `@@ -1,9 +1,9 @@ ${trailer}:\n${body.join('\n')}`;
}

// The summary only replaces hunks it shrinks, so a fixture needs bulk before
// the substitution happens at all. This padding carries no resolved edges: it
// sits in `packages:`, where six-space lines are peer ranges.
function padding() {
  return hunk(
    'packages',
    Array.from(
      { length: 40 },
      (_, index) =>
        `${entry('-', `filler-${index}`, '1.0.0')}\n${entry('+', `filler-${index}`, '2.0.0')}`
    ).join('\n')
  );
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

test('a repointed edge is reported with the parent the diff shows', () => {
  // #3053 lifted undici 7.28.0 -> 7.29.1 by repointing edges at an entry that
  // was already in the lockfile. Neither end is an added or removed entry, so
  // the lists above this section are structurally blind to it: the reviewer saw
  // only unrelated 6.28.1/8.10.2 additions and read them as the subtree leaving
  // the 7.x line, then had to ask for `pnpm why undici` by hand.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@ai-sdk/provider-utils@5.0.32(zod@4.5.4)':",
        '     dependencies:',
        '       eventsource-parser: 3.1.0',
        '-      undici: 7.28.0',
        '+      undici: 7.29.1',
        '       zod: 4.5.4'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 1 across 1 transition/);
  assert.match(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): @ai-sdk\/provider-utils@5\.0\.32/);
});

test('an optionalDependencies edge repointing is reported too', () => {
  // #3053 repointed one under `optionalDependencies:` (electron's undici).
  // Reporting only `dependencies:` would drop it silently.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        '   electron@40.4.0:',
        '     optionalDependencies:',
        '-      undici: 7.28.0',
        '+      undici: 7.29.1'
      ),
      padding()
    )
  );
  assert.match(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): electron@40\.4\.0/);
});

test('a hunk boundary does not carry a parent into the next hunk', () => {
  // Hunks are not contiguous. #3053's flagship hunk contained neither its block
  // key nor its `dependencies:` line — both sat outside -U3 context. Holding the
  // previous hunk's parent would attribute the edge to the wrong package, which
  // is worse than not naming one: it is confidently wrong.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@actions/http-client@4.0.1':",
        '     dependencies:',
        '       tunnel: 0.0.6',
        '-      undici: 6.28.0',
        '+      undici: 6.28.1'
      ),
      hunk(
        'snapshots',
        '       eventsource-parser: 3.1.0',
        '-      undici: 7.28.0',
        '+      undici: 7.29.1',
        '       zod: 4.5.4'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 2 across 2 transitions/);
  assert.match(out, /undici: 6\.28\.0 => 6\.28\.1 \(1 edge\): @actions\/http-client@4\.0\.1/);
  assert.doesNotMatch(
    out,
    /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): @actions/,
    'a parent from a previous hunk must never be attributed to this one'
  );
  assert.match(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): 1 with no parent in this diff/);
});

test('peer ranges outside the snapshots section are not read as resolved edges', () => {
  // `packages:` entries carry `peerDependencies:` at the same six-space depth,
  // but those values are ranges, not resolved versions. Reporting one as a
  // repointed edge would invent a graph change that did not happen.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'packages',
        "   '@codemirror/view@6.1.0':",
        '     peerDependencies:',
        "-      '@codemirror/state': ^6.0.0",
        "+      '@codemirror/state': ^6.5.0"
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 0/);
  assert.doesNotMatch(out, /\^6\.0\.0 => \^6\.5\.0/);
});

test('a peer suffix on a parent key does not steal the parent version', () => {
  // The same false-green class splitPackageKey exists for: a bare
  // lastIndexOf('@'), or printing the raw key, reads or shows the peer's
  // version where the parent's belongs.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@codemirror/view@6.1.0(@codemirror/state@6.5.2)':",
        '     dependencies:',
        '-      style-mod: 4.1.0',
        '+      style-mod: 4.1.2'
      ),
      padding()
    )
  );
  assert.match(out, /style-mod: 4\.1\.0 => 4\.1\.2 \(1 edge\): @codemirror\/view@6\.1\.0$/m);
  assert.doesNotMatch(out, /@codemirror\/state@6\.5\.2/);
});

test('an edge added or dropped outright is not reported as a repointing', () => {
  // Pairing by position rather than by name would read an unrelated removal and
  // addition as one edge moving. A whole added or removed snapshot block is
  // already visible in the entry lists above.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@actions/http-client@4.0.1':",
        '     dependencies:',
        '-      tunnel: 0.0.6',
        '+      undici: 6.28.1'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 0/);
  assert.doesNotMatch(out, /tunnel: 0\.0\.6 => 6\.28\.1/);
});

test('a transition names its parents up to a cap and counts the rest', () => {
  // One transition can carry hundreds of edges in a dedupe. The transition line
  // is what the reviewer needs; the parent roll is detail, so it is the part
  // that gets capped.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      ...Array.from({ length: 30 }, (_, index) =>
        hunk(
          'snapshots',
          `   parent-${String(index).padStart(2, '0')}@1.0.0:`,
          '     dependencies:',
          '-      shared-dep: 1.0.0',
          '+      shared-dep: 2.0.0'
        )
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 30 across 1 transition/);
  assert.match(
    out,
    /shared-dep: 1\.0\.0 => 2\.0\.0 \(30 edges\): parent-00@1\.0\.0, parent-01@1\.0\.0, parent-02@1\.0\.0, parent-03@1\.0\.0, and 26 more parents$/m
  );
});

test('the transition list itself is capped and the remainder counted', () => {
  // Grouping bounds the section by distinct transitions rather than by edges,
  // but a wide `pnpm update` can still produce many. An unbounded list would
  // spend on repetition the context this script exists to save.
  // Emitted in reverse so insertion order and sorted order disagree: which
  // transitions survive the cap must be a decision, not an accident of the
  // order the hunks happened to arrive in. A reviewer re-reading a re-pushed
  // PR should see the same list.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      ...Array.from({ length: 20 }, (_, offset) => {
        const index = String(19 - offset).padStart(2, '0');
        return hunk(
          'snapshots',
          `   parent-${index}@1.0.0:`,
          '     dependencies:',
          `-      dep-${index}: 1.0.0`,
          `+      dep-${index}: 2.0.0`
        );
      }),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 20 across 20 transitions/);
  const listed = out.split('\n').filter((line) => /[=]> 2\.0\.0 \(1 edge\)/.test(line));
  assert.equal(listed.length, 12, 'the transition list must stop at the cap');
  assert.match(out, /dep-00: 1\.0\.0 => 2\.0\.0/);
  assert.match(out, /dep-11: 1\.0\.0 => 2\.0\.0/);
  assert.doesNotMatch(out, /dep-12: 1\.0\.0 => 2\.0\.0/, 'the cap must cut by sort order');
  assert.match(out, /and 8 more transitions covering 8 edges/);
});

test('a reordered dependency line is not reported as a repointing', () => {
  // A line that moves within a block is emitted as a removal and an addition of
  // the same text. Both sides carry the same version, so nothing was repointed.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@actions/http-client@4.0.1':",
        '     dependencies:',
        '-      undici: 6.28.0',
        '       tunnel: 0.0.6',
        '+      undici: 6.28.0'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 0/);
  assert.doesNotMatch(out, /undici: 6\.28\.0 => 6\.28\.0/);
});

test('an edge is still reported when the hunk shows neither its key nor dependencies:', () => {
  // The exact shape of #3053's flagship hunk (@@ -14848,7 +14852,7 @@ snapshots:):
  // the block key sat six lines above the changed dependency and `dependencies:`
  // five, so -U3 context carried neither. Scoping edges by the enclosing
  // `dependencies:` key rather than by the section drops this edge entirely —
  // the one edge the whole section exists to surface.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        '       eventsource-parser: 3.1.0',
        '-      undici: 7.28.0',
        '+      undici: 7.29.1',
        '       zod: 4.5.4'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 1 across 1 transition/);
  assert.match(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): 1 with no parent in this diff/);
});

test('two blocks in one hunk each keep their own parent', () => {
  // #3053's first snapshots hunk spanned three blocks. Pairing pending lines
  // against the parent that replaced them, rather than the one in scope when
  // they were read, shifts every attribution by one block — and a fixture with
  // a single block per hunk cannot tell the difference.
  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      hunk(
        'snapshots',
        "   '@actions/http-client@3.0.2':",
        '     dependencies:',
        '       tunnel: 0.0.6',
        '-      undici: 6.28.0',
        '+      undici: 6.28.1',
        ' ',
        '   vercel@50.1.0:',
        '     dependencies:',
        '       tar-stream: 3.1.7',
        '-      undici: 7.28.0',
        '+      undici: 7.29.1'
      ),
      padding()
    )
  );
  assert.match(out, /dependency edges repointed: 2 across 2 transitions/);
  assert.match(out, /undici: 6\.28\.0 => 6\.28\.1 \(1 edge\): @actions\/http-client@3\.0\.2/);
  assert.match(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): vercel@50\.1\.0/);
  assert.doesNotMatch(
    out,
    /undici: 6\.28\.0 => 6\.28\.1 \(1 edge\): vercel/,
    'attribution must not shift forward'
  );
  assert.doesNotMatch(out, /undici: 7\.28\.0 => 7\.29\.1 \(1 edge\): @actions/);
});

test('a diff with no repointed edges pays one line, not a prose block', () => {
  // This section is emitted on every summary, so its fixed cost is charged to
  // every dependency PR. A summary only replaces hunks it shrinks, so standing
  // prose pushes borderline diffs back to passing through whole — narrowing
  // what the tool helps with at all. The caveat earns its bytes only where
  // there are edges to qualify.
  const { diff: out } = summarizeLockfileDiff(
    lockfile(
      Array.from(
        { length: 40 },
        (_, index) =>
          `${entry('-', `dep-${index}`, '1.0.0')}\n${entry('+', `dep-${index}`, '2.0.0')}`
      ).join('\n')
    )
  );
  assert.match(out, /dependency edges repointed: 0 \(snapshots only\)/);
  assert.doesNotMatch(out, /parents named only where shown/);
});

test('every count in the section agrees with itself on plurals', () => {
  // 13 transitions is one over the cap, so the overflow reads "1 more"; five
  // parents is one over that cap, so the roll does too. Both singular tails are
  // reachable, and 'and 1 more transitions covering 1 edges' is the kind of
  // seam that survives review because nobody builds the fixture that hits it.
  const overflow = summarizeLockfileDiff(
    lockfileHunks(
      ...Array.from({ length: 13 }, (_, index) => {
        const key = String(index).padStart(2, '0');
        return hunk(
          'snapshots',
          `   parent-${key}@1.0.0:`,
          '     dependencies:',
          `-      dep-${key}: 1.0.0`,
          `+      dep-${key}: 2.0.0`
        );
      }),
      padding()
    )
  ).diff;
  assert.match(overflow, /and 1 more transition covering 1 edge$/m);

  const parents = summarizeLockfileDiff(
    lockfileHunks(
      ...Array.from({ length: 5 }, (_, index) =>
        hunk(
          'snapshots',
          `   parent-${index}@1.0.0:`,
          '     dependencies:',
          '-      shared: 1.0.0',
          '+      shared: 2.0.0'
        )
      ),
      padding()
    )
  ).diff;
  assert.match(parents, /and 1 more parent$/m);
});

test('edges in a hunk with no section header are counted, never silently dropped', () => {
  // gh pr diff always emits a funcname trailer for this file, because line 1 is
  // `lockfileVersion:` and the default pattern matches it. If that ever fails,
  // the failure mode is under-reporting while presenting a confident count —
  // so the lines that could not be classified are stated rather than dropped.
  const { edges, unclassified } = collectEdges([
    '@@ -1,9 +1,9 @@',
    '   foo@1.0.0:',
    '     dependencies:',
    '-      undici: 7.28.0',
    '+      undici: 7.29.1',
  ]);
  assert.deepEqual(edges, []);
  assert.equal(unclassified, 2);

  const { diff: out } = summarizeLockfileDiff(
    lockfileHunks(
      '@@ -1,9 +1,9 @@\n   foo@1.0.0:\n     dependencies:\n-      undici: 7.28.0\n+      undici: 7.29.1',
      padding()
    )
  );
  assert.match(out, /2 changed dependency lines in hunks with no section header/);
});

test('collectEdges reports the parent split directly', () => {
  // Exercised without the shrink-threshold padding a full summary needs, which
  // is what makes the parent/anonymous split legible.
  const { edges, unclassified } = collectEdges([
    '@@ -1,9 +1,9 @@ snapshots:',
    "   '@actions/http-client@4.0.1':",
    '     dependencies:',
    '-      undici: 6.28.0',
    '+      undici: 6.28.1',
    '@@ -9,9 +9,9 @@ snapshots:',
    '-      undici: 7.28.0',
    '+      undici: 7.29.1',
  ]);
  assert.equal(unclassified, 0);
  assert.deepEqual(edges, [
    {
      from: '6.28.0',
      name: 'undici',
      parent: { name: '@actions/http-client', version: '4.0.1' },
      to: '6.28.1',
    },
    { from: '7.28.0', name: 'undici', parent: null, to: '7.29.1' },
  ]);
});
