import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/claude-code-review.yml', 'utf8');

function stepNamed(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Claude Auto Review must define the "${name}" step.`);
  const nextStep = workflow.indexOf('\n      - ', start + 1);
  return nextStep === -1 ? workflow.slice(start) : workflow.slice(start, nextStep);
}

function runScript(step) {
  const lines = step.split('\n');
  const runIndex = lines.indexOf('        run: |');
  assert.notEqual(runIndex, -1, 'The workflow step must contain a run script.');
  return lines
    .slice(runIndex + 1)
    .map((line) => (line === '' ? '' : line.slice(10)))
    .join('\n');
}

test('an incomplete Claude review posts a visible disposition and leaves the job red', () => {
  const reviewStep = stepNamed('Run Claude auto-review');
  assert.match(reviewStep, /^ {8}id: claude-review$/m);
  assert.match(reviewStep, /^ {8}continue-on-error: true$/m);

  const failureStep = stepNamed('Report incomplete Claude review');
  assert.match(failureStep, /^ {8}if: \$\{\{ steps\.claude-review\.outcome == 'failure' \}\}$/m);
  assert.match(failureStep, /gh pr comment/);
  assert.match(failureStep, /Claude auto-review did not complete/);
  assert.match(failureStep, /exit 1/);

  const fixture = mkdtempSync(path.join(tmpdir(), 'claude-review-contract-'));
  const fakeGh = path.join(fixture, 'gh');
  const capture = path.join(fixture, 'gh-args.txt');

  try {
    writeFileSync(fakeGh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_CAPTURE"\n');
    chmodSync(fakeGh, 0o755);

    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', runScript(failureStep)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_CAPTURE: capture,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'seandearnaley/brainstrike',
        PATH: `${fixture}:${process.env.PATH}`,
        PR_NUMBER: '1412',
        RUN_URL: 'https://github.com/seandearnaley/brainstrike/actions/runs/123',
      },
    });

    assert.equal(result.status, 1, 'The incomplete-review handler must fail the job visibly.');
    const args = readFileSync(capture, 'utf8');
    assert.match(args, /^pr\ncomment\n1412\n/m);
    assert.match(args, /Claude auto-review did not complete/);
    assert.match(args, /actions\/runs\/123/);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test('completed reviews cannot trigger the incomplete-review handler', () => {
  const failureStep = stepNamed('Report incomplete Claude review');
  assert.match(failureStep, /^ {8}if: \$\{\{ steps\.claude-review\.outcome == 'failure' \}\}$/m);
  assert.doesNotMatch(failureStep, /always\(\)/);
});

test('review instructions stay on the exact PR diff and approved GitHub surfaces', () => {
  const reviewStep = stepNamed('Run Claude auto-review');
  assert.match(reviewStep, /Review only the exact pull request diff returned by `gh pr diff`/);
  assert.match(reviewStep, /Do not inspect or crawl the checked-out repository/);
  assert.match(
    reviewStep,
    /--max-turns 80 --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash\(gh pr comment:\*\),Bash\(gh pr diff:\*\),Bash\(gh pr view:\*\)"/
  );
});
