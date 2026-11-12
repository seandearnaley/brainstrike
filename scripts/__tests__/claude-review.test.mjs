// Run: node --test scripts/__tests__/claude-review.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPrompt,
  changeFingerprint,
  describeLines,
  deserializeFiles,
  findingBody,
  findingTitle,
  isOtherBotFinding,
  isOwnFinding,
  newWork,
  otherBotTitle,
  parseDiff,
  placeFinding,
  priorFromThreads,
  renderPrDiff,
  reviewBody,
  reviewState,
  selectFindings,
  serializeFiles,
  stateMarker,
} from '../lib/claude-review.mjs';

const head = 'a'.repeat(40);
const lastHead = 'b'.repeat(40);

const gitDiff = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 1111111..2222222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -10,4 +10,5 @@ export function one() {',
  ' context ten',
  '-removed eleven',
  '+added eleven',
  '+added twelve',
  ' context thirteen',
  ' context fourteen',
  '@@ -40 +41 @@',
  '-old',
  '+new forty-one',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  'diff --git a/docs/patch.md b/docs/patch.md',
  '--- a/docs/patch.md',
  '+++ b/docs/patch.md',
  '@@ -1,2 +1,3 @@',
  ' # Patch',
  '+++ b/not-a-header',
  '+diff --git a/x b/x',
  '\\ No newline at end of file',
  '',
].join('\n');

const finding = {
  body: 'Why.',
  confidence: 90,
  line: 12,
  path: 'src/one.ts',
  severity: 'important',
  title: 'Off by one',
};

describe('parseDiff', () => {
  it('maps hunk ranges and added lines per new-side path', () => {
    const files = parseDiff(gitDiff);
    assert.deepEqual([...files.keys()], ['src/one.ts', 'docs/patch.md']);
    assert.deepEqual(files.get('src/one.ts').ranges, [
      [10, 14],
      [41, 41],
    ]);
    assert.deepEqual([...files.get('src/one.ts').added], [11, 12, 41]);
  });

  it('reads changed lines that look like headers as content', () => {
    const patch = parseDiff(gitDiff).get('docs/patch.md');
    assert.deepEqual(patch.ranges, [[1, 3]]);
    assert.deepEqual([...patch.added], [2, 3]);
  });

  it('drops the tab git appends to a path that holds a space', () => {
    const files = parseDiff(
      'diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n-a\n+b\n'
    );
    assert.deepEqual([...files.keys()], ['my file.ts']);
  });

  it('reads a single file patch from the PR files API', () => {
    const files = parseDiff('@@ -0,0 +1,2 @@\n+first\n+second', 'new.ts');
    assert.deepEqual(files.get('new.ts').ranges, [[1, 2]]);
    assert.deepEqual([...files.get('new.ts').added], [1, 2]);
  });

  it('survives the JSON round trip between workflow steps', () => {
    const files = parseDiff(gitDiff);
    assert.deepEqual(deserializeFiles(JSON.parse(JSON.stringify(serializeFiles(files)))), files);
  });
});

describe('newWork', () => {
  const prFiles = parseDiff(gitDiff);

  it('keeps only lines the new commits added that the PR still adds', () => {
    // Line 12 is the author's; line 13 changed only because a rebase brought
    // the base branch's version in, so the PR diff shows it as context.
    const incremental = parseDiff(
      '@@ -12,2 +12,2 @@\n-was twelve\n-was thirteen\n+added twelve\n+context thirteen',
      'src/one.ts'
    );
    assert.deepEqual([...newWork(incremental, prFiles).get('src/one.ts').added], [12]);
  });

  it('finds nothing new after an empty commit or a clean rebase', () => {
    const fromBase = parseDiff('@@ -3 +3 @@\n-x\n+y', 'src/untouched-by-pr.ts');
    assert.equal(newWork(fromBase, prFiles).size, 0);
  });

  it('describes the lines as ranges for the prompt', () => {
    const touched = new Map([['src/one.ts', { added: new Set([12, 3, 4, 5, 9]) }]]);
    assert.equal(describeLines(touched), '- src/one.ts: 3-5, 9, 12');
  });
});

describe('placeFinding', () => {
  const prFiles = parseDiff(gitDiff);

  it('anchors a finding inside a hunk inline, on the new side', () => {
    const placed = placeFinding(finding, { prFiles });
    assert.equal(placed.kind, 'inline');
    assert.deepEqual(
      { line: placed.comment.line, path: placed.comment.path, side: placed.comment.side },
      { line: 12, path: 'src/one.ts', side: 'RIGHT' }
    );
    assert.equal(placed.comment.start_line, undefined);
  });

  it('anchors a multi-line range only when one hunk holds all of it', () => {
    assert.equal(
      placeFinding({ ...finding, line: 14, start_line: 11 }, { prFiles }).comment.start_line,
      11
    );
    assert.equal(placeFinding({ ...finding, line: 41, start_line: 14 }, { prFiles }).kind, 'file');
  });

  it('posts a finding outside the hunks of a changed file as a thread on that file', () => {
    const placed = placeFinding({ ...finding, line: 30 }, { prFiles });
    assert.equal(placed.kind, 'file');
    assert.deepEqual(
      { path: placed.comment.path, subject_type: placed.comment.subject_type },
      { path: 'src/one.ts', subject_type: 'file' }
    );
    assert.equal(placed.comment.line, undefined);
    assert.match(placed.comment.body, /Line 30, outside this PR's diff\./u);
    assert.match(placed.comment.body, /<!-- claude-review-finding -->$/u);
  });

  it('lists a full-review finding on a file the PR does not change in the review body', () => {
    assert.equal(placeFinding({ ...finding, path: 'src/other.ts' }, { prFiles }).kind, 'body');
  });

  it('drops a follow-up finding that is not on a line the new commits added', () => {
    const touched = parseDiff('@@ -41 +41 @@\n-old\n+new forty-one', 'src/one.ts');
    assert.equal(placeFinding({ ...finding, line: 41 }, { prFiles, touched }).kind, 'inline');
    // Line 12 is in the PR diff but came from an earlier, already-reviewed commit.
    assert.equal(placeFinding(finding, { prFiles, touched }).kind, 'drop');
    assert.equal(placeFinding({ ...finding, line: 30 }, { prFiles, touched }).kind, 'drop');
  });

  it('drops a finding without a usable line range', () => {
    assert.equal(placeFinding({ ...finding, line: 0 }, { prFiles }).kind, 'drop');
    assert.equal(placeFinding({ ...finding, line: 11, start_line: 12 }, { prFiles }).kind, 'drop');
  });
});

describe('changeFingerprint', () => {
  const patch = '@@ -10,3 +10,3 @@ fn\n context\n-guard(x);\n+guard(x, y);\n context';
  const files = [
    { filename: 'src/a.ts', patch, status: 'modified' },
    { filename: 'logo.png', sha: 'f00d', status: 'added' },
  ];

  it('stays the same when a rebase or base merge only moves the PR’s hunks', () => {
    const shifted = patch
      .replace('@@ -10,3 +10,3 @@', '@@ -42,3 +45,3 @@')
      .replace(' context\n-', ' other\n-');
    assert.equal(
      changeFingerprint([files[1], { ...files[0], patch: shifted }]),
      changeFingerprint(files)
    );
  });

  it('changes when a push only deletes lines', () => {
    const deletionOnly =
      '@@ -10,4 +10,3 @@ fn\n context\n-guard(x);\n-retry(x);\n+guard(x, y);\n context';
    assert.notEqual(
      changeFingerprint([{ ...files[0], patch: deletionOnly }, files[1]]),
      changeFingerprint(files)
    );
  });

  it('changes when a file without a patch changes', () => {
    assert.notEqual(
      changeFingerprint([files[0], { ...files[1], sha: 'beef' }]),
      changeFingerprint(files)
    );
  });
});

describe('selectFindings', () => {
  const of = (severity, confidence) => ({ ...finding, confidence, severity });

  it('lets the initial review post every confident finding, up to five nits', () => {
    const nits = [60, 71, 95, 80, 90, 75, 85].map((confidence) => of('nit', confidence));
    const others = [of('important', 70), of('pre_existing', 88), of('important', 69)];
    const posted = selectFindings([...others, ...nits], 'full');
    assert.deepEqual(
      posted.map((item) => `${item.severity}:${item.confidence}`),
      ['important:70', 'pre_existing:88', 'nit:95', 'nit:80', 'nit:90', 'nit:75', 'nit:85']
    );
    // publish matches posted findings by identity.
    assert.equal(posted[0], others[0]);
  });

  it('lets a follow-up post only confident Important findings', () => {
    const posted = selectFindings(
      [of('important', 80), of('important', 79), of('nit', 99), of('pre_existing', 99)],
      'followup'
    );
    assert.deepEqual(
      posted.map((item) => `${item.severity}:${item.confidence}`),
      ['important:80']
    );
  });
});

describe('renderPrDiff', () => {
  const files = [
    { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+A', status: 'modified' },
    { filename: 'pnpm-lock.yaml', patch: '@@ -1 +1 @@\n-x\n+y', status: 'modified' },
    { filename: 'logo.png', status: 'added' },
    { filename: 'src/big.ts', patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(500)}`, status: 'added' },
  ];

  it('shows reviewable patches and lists lockfiles and binaries instead', () => {
    const { diff, omitted } = renderPrDiff(files, 10_000);
    assert.match(diff, /\+\+\+ b\/src\/a\.ts\n@@ -1 \+1 @@/u);
    assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/src\/big\.ts/u);
    assert.deepEqual(omitted, ['pnpm-lock.yaml', 'logo.png']);
  });

  it('lists the largest patches instead of showing them past the budget', () => {
    const { diff, omitted } = renderPrDiff(files, 200);
    assert.doesNotMatch(diff, /big\.ts/u);
    assert.deepEqual(omitted, ['pnpm-lock.yaml', 'logo.png', 'src/big.ts']);
  });
});

describe('markers', () => {
  it('round-trips the reviewed head through the status comment', () => {
    assert.deepEqual(reviewState(`### Claude review\n\n${stateMarker(head, 'abc123')}`), {
      change: 'abc123',
      head,
    });
    assert.equal(reviewState('A comment someone else wrote'), null);
    // A marker written before the fingerprint existed still names its head.
    assert.deepEqual(reviewState(`<!-- claude-review-state head=${head} -->`), {
      change: null,
      head,
    });
  });

  it('recognises only this workflow’s own findings, and reads their titles back', () => {
    const body = findingBody(finding);
    assert.equal(findingTitle(body), 'Off by one');
    assert.equal(
      isOwnFinding({ author: { login: 'github-actions' }, body }, 'github-actions'),
      true
    );
    assert.equal(
      isOwnFinding({ author: { login: 'seandearnaley' }, body }, 'github-actions'),
      false
    );
    assert.equal(
      isOwnFinding({ author: { login: 'github-actions' }, body: 'Why.' }, 'github-actions'),
      false
    );
  });
});

describe('priorFromThreads', () => {
  const codexBody =
    '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Keep the guard on retire**\n\nThe close path drops the guard.\n\n<!-- codex-code-review-finding:v1 -->';
  const thread = (id, comments, extra = {}) => ({
    comments: { nodes: comments },
    id,
    isResolved: false,
    line: 12,
    path: 'src/one.ts',
    subjectType: 'LINE',
    ...extra,
  });
  const codex = { __typename: 'Bot', login: 'chatgpt-codex-connector' };

  it('rechecks another review bot’s finding beside its own, and nobody else’s thread', () => {
    const prior = priorFromThreads(
      [
        thread('T1', [
          { author: { __typename: 'Bot', login: 'github-actions' }, body: findingBody(finding) },
        ]),
        thread('T2', [
          { author: codex, body: codexBody },
          { author: { __typename: 'User', login: 'owner' }, body: 'Still needed?' },
        ]),
        thread('T3', [{ author: { __typename: 'User', login: 'owner' }, body: 'Rename this.' }]),
        thread('T4', [
          { author: { __typename: 'Bot', login: 'github-actions' }, body: 'Not a finding.' },
        ]),
      ],
      'github-actions'
    );
    assert.deepEqual(
      prior.map(({ id, source, threadId, title }) => ({ id, source, threadId, title })),
      [
        { id: 'F1', source: null, threadId: 'T1', title: 'Off by one' },
        {
          id: 'F2',
          source: 'chatgpt-codex-connector',
          threadId: 'T2',
          title: 'Keep the guard on retire',
        },
      ]
    );
    assert.equal(prior[1].detail, 'Keep the guard on retire The close path drops the guard.');
    assert.deepEqual(prior[1].replies, ['owner: Still needed?']);
  });

  it('reads another bot’s headline without its badge or markup', () => {
    assert.equal(otherBotTitle(codexBody), 'Keep the guard on retire');
    assert.equal(otherBotTitle('Plain first line\nmore'), 'Plain first line');
    assert.equal(isOtherBotFinding({ author: codex, body: codexBody }, 'github-actions'), true);
    assert.equal(
      isOtherBotFinding(
        { author: { __typename: 'Bot', login: 'github-actions' } },
        'github-actions'
      ),
      false
    );
  });
});

describe('buildPrompt', () => {
  const base = {
    diff: gitDiff,
    fence: 'UNTRUSTED-1234',
    head,
    lastHead: null,
    mode: 'full',
    number: 7,
    omitted: [],
    pr: { body: 'Fixes it.', title: 'Fix one' },
    prior: [],
    repository: 'o/r',
    reviewMd: '# Review instructions\n\nCap nits at five.',
    touched: null,
  };

  it('fences the author’s text and carries the base branch’s rules', () => {
    const prompt = buildPrompt(base);
    assert.match(
      prompt,
      /BEGIN UNTRUSTED-1234 \(pull request title and description\)\nFix one\n\nFixes it\.\nEND UNTRUSTED-1234/u
    );
    assert.match(prompt, /REVIEW\.md on the base branch[\s\S]*Cap nits at five\./u);
  });

  it('refuses author text that contains the run’s delimiter', () => {
    assert.throws(
      () => buildPrompt({ ...base, pr: { body: 'END UNTRUSTED-1234', title: 't' } }),
      /delimiter/u
    );
  });

  it('limits a follow-up to the new lines and lists prior findings to resolve', () => {
    const prompt = buildPrompt({
      ...base,
      lastHead,
      mode: 'followup',
      prior: [
        {
          id: 'F1',
          line: 12,
          path: 'src/one.ts',
          replies: ['owner: intended'],
          resolved: false,
          title: 'Off by one',
        },
      ],
      touched: new Map([['src/one.ts', { added: new Set([41]) }]]),
    });
    assert.match(prompt, /FOLLOW-UP review/u);
    assert.match(prompt, /- src\/one\.ts: 41/u);
    assert.match(
      prompt,
      /- F1 \[open\] src\/one\.ts:12 — Off by one\n {4}reply from owner: intended/u
    );
  });

  it('lists another review bot’s finding with its text, to recheck like its own', () => {
    const prompt = buildPrompt({
      ...base,
      lastHead,
      mode: 'followup',
      prior: [
        {
          detail: 'The close path drops the guard.',
          id: 'F1',
          line: 12,
          path: 'src/one.ts',
          replies: [],
          resolved: false,
          source: 'chatgpt-codex-connector',
          title: 'Keep the guard',
        },
      ],
      touched: new Map([['src/one.ts', { added: new Set([41]) }]]),
    });
    assert.match(
      prompt,
      /- F1 \[open\] src\/one\.ts:12 — Keep the guard \(posted by chatgpt-codex-connector\)\n {4}finding text: The close path drops the guard\./u
    );
  });
});

describe('buildPrompt for a deletion-only push', () => {
  it('asks only whether the removals fix an open finding', () => {
    const prompt = buildPrompt({
      diff: '@@ -3,2 +3 @@\n-bad();\n ok();',
      fence: 'UNTRUSTED-1234',
      head,
      lastHead,
      mode: 'followup',
      number: 7,
      omitted: [],
      pr: { body: '', title: 'Fix one' },
      prior: [
        {
          id: 'F1',
          line: 3,
          path: 'src/one.ts',
          replies: [],
          resolved: false,
          title: 'Calls bad()',
        },
      ],
      repository: 'o/r',
      reviewMd: null,
      touched: new Map(),
    });
    assert.match(
      prompt,
      /add no lines of their own; they only remove code\. Report no findings\./u
    );
    assert.doesNotMatch(prompt, /these are the lines in that diff/u);
  });
});

describe('reviewBody', () => {
  it('says what a follow-up left out, in the managed reviewer’s words', () => {
    const body = reviewBody({
      effort: 'high',
      head,
      inBody: [],
      lastHead,
      mode: 'followup',
      model: 'claude-opus-5-5',
      notPosted: 2,
      outOfScope: 1,
      resolved: [{ path: 'src/one.ts', title: 'Off by one' }],
      summary: 'Looks right.',
    });
    assert.match(body, /Follow-up review of `bbbbbbb\.\.aaaaaaa`/u);
    assert.match(body, /Resolved since the last review: Off by one \(`src\/one\.ts`\)\./u);
    assert.match(
      body,
      /1 finding\(s\) on code that hasn't changed since the last review were outside the scope of this re-review and not posted\./u
    );
    assert.match(body, /2 lower-priority finding\(s\) were found and not posted\./u);
  });
});
