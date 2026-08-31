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

function runClassifier(messages, { writeExecutionFile = true } = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'claude-review-contract-'));
  const executionFile = path.join(fixture, 'execution.json');
  const outputFile = path.join(fixture, 'github-output.txt');
  const summaryFile = path.join(fixture, 'summary.md');

  try {
    if (writeExecutionFile) {
      writeFileSync(executionFile, JSON.stringify(messages));
    }
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');
    const result = spawnSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', runScript(stepNamed('Classify primary Claude failure'))],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_EXECUTION_FILE: executionFile,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
        },
      }
    );
    return {
      output: readFileSync(outputFile, 'utf8'),
      result,
      summary: readFileSync(summaryFile, 'utf8'),
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

function transientFailure({ status = 429, text = 'API Error: rate_limit_error' } = {}) {
  return [
    { session_id: 'session', subtype: 'init', type: 'system' },
    {
      apiErrorStatus: status,
      message: { content: [{ text, type: 'text' }] },
      type: 'assistant',
    },
    {
      api_error_status: status,
      is_error: true,
      num_turns: 1,
      permission_denials: [],
      subtype: 'success',
      terminal_reason: 'api_error',
      total_cost_usd: 0,
      type: 'result',
    },
  ];
}

test('auto-review uses metered API capacity and per-PR non-cancelling concurrency', () => {
  assert.match(
    workflow,
    /^concurrency:\n {2}group: claude-auto-review-\$\{\{ github\.event\.pull_request\.number \}\}$/m
  );
  assert.match(workflow, /^ {2}cancel-in-progress: false$/m);

  const primary = stepNamed('Run primary Claude auto-review');
  const retry = stepNamed('Retry Claude auto-review once');
  for (const step of [primary, retry]) {
    assert.match(step, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    assert.doesNotMatch(step, /claude_code_oauth_token/);
    assert.match(step, /show_full_output: false/);
    assert.match(step, /^ {8}continue-on-error: true$/m);
  }
});

test('only exact zero-work API rate-limit and overload records authorize one retry', () => {
  for (const messages of [
    transientFailure(),
    transientFailure({ status: 529, text: 'API Error: overloaded_error: Overloaded' }),
  ]) {
    const classified = runClassifier(messages);
    assert.equal(classified.result.status, 0, classified.result.stderr);
    assert.match(classified.output, /^classification=transient-capacity$/m);
    assert.match(classified.output, /^retryable=true$/m);
  }

  const retry = stepNamed('Retry Claude auto-review once');
  assert.match(retry, /steps\.classify-claude-failure\.outputs\.retryable == 'true'/);
  assert.match(stepNamed('Back off before one safe retry'), /sleep 60/);
  assert.equal((workflow.match(/uses: anthropics\/claude-code-action@v1/g) ?? []).length, 2);
});

test('subscription and spend exhaustion remain non-retryable even when the status is 429', () => {
  for (const text of [
    "You've hit your limit · resets 5am",
    "You've hit your weekly limit · resets tomorrow",
    "You're out of extra usage · resets 6pm",
    'Credit balance is too low',
    'Organization spend limit reached',
  ]) {
    const classified = runClassifier(transientFailure({ text }));
    assert.equal(classified.result.status, 0, classified.result.stderr);
    assert.match(classified.output, /^classification=capacity-exhausted$/m);
    assert.match(classified.output, /^retryable=false$/m);
  }
});

test('partial review records never retry after cost, multiple turns, tool use, or permission denial', () => {
  const cases = [];
  const spent = transientFailure();
  spent.at(-1).total_cost_usd = 0.01;
  cases.push(spent);

  const multipleTurns = transientFailure();
  multipleTurns.at(-1).num_turns = 2;
  cases.push(multipleTurns);

  const usedTool = transientFailure();
  usedTool.splice(2, 0, {
    message: { content: [{ id: 'tool-1', name: 'Bash', type: 'tool_use' }] },
    type: 'assistant',
  });
  cases.push(usedTool);

  const deniedTool = transientFailure();
  deniedTool.at(-1).permission_denials = [{ tool_name: 'Bash' }];
  cases.push(deniedTool);

  for (const messages of cases) {
    const classified = runClassifier(messages);
    assert.equal(classified.result.status, 0, classified.result.stderr);
    assert.match(classified.output, /^classification=partial-or-unknown$/m);
    assert.match(classified.output, /^retryable=false$/m);
  }
});

test('missing metrics, execution data, and unknown or authentication failures remain red', () => {
  const missingMetric = transientFailure();
  Reflect.deleteProperty(missingMetric.at(-1), 'num_turns');
  const unknown429 = transientFailure({ text: 'unclassified provider response' });
  const authentication = transientFailure({ status: 401, text: 'authentication_error' });

  for (const [messages, classification] of [
    [missingMetric, 'partial-or-unknown'],
    [unknown429, 'unknown'],
    [authentication, 'unknown'],
  ]) {
    const classified = runClassifier(messages);
    assert.equal(classified.result.status, 0, classified.result.stderr);
    assert.match(classified.output, new RegExp(`^classification=${classification}$`, 'm'));
    assert.match(classified.output, /^retryable=false$/m);
  }

  const missing = runClassifier([], { writeExecutionFile: false });
  assert.equal(missing.result.status, 0, missing.result.stderr);
  assert.match(missing.output, /^classification=invalid-execution-record$/m);
  assert.match(missing.output, /^retryable=false$/m);
});

test('classification keeps raw execution content private', () => {
  const sensitiveMarker = 'DO-NOT-PRINT-RAW-CLAUDE-CONTENT';
  const messages = transientFailure();
  messages[0].sensitive = sensitiveMarker;
  const classified = runClassifier(messages);
  const visible = [
    classified.result.stdout,
    classified.result.stderr,
    classified.output,
    classified.summary,
  ].join('\n');
  assert.doesNotMatch(visible, new RegExp(sensitiveMarker));
  assert.match(visible, /transient-capacity/);
});

test('one final handler posts one visible disposition and leaves incomplete review red', () => {
  const failureStep = stepNamed('Report incomplete Claude review');
  assert.match(failureStep, /always\(\)/);
  assert.match(failureStep, /steps\.claude-review-primary\.outcome != 'success'/);
  assert.match(failureStep, /steps\.claude-review-retry\.outcome != 'success'/);
  assert.equal((failureStep.match(/gh pr comment/g) ?? []).length, 1);
  assert.match(failureStep, /exit 1/);

  const fixture = mkdtempSync(path.join(tmpdir(), 'claude-review-handler-'));
  const fakeGh = path.join(fixture, 'gh');
  const capture = path.join(fixture, 'gh-args.txt');
  try {
    writeFileSync(fakeGh, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$GH_CAPTURE"\n');
    chmodSync(fakeGh, 0o755);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', runScript(failureStep)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAILURE_CLASSIFICATION: 'unknown',
        GH_CAPTURE: capture,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'seandearnaley/brainstrike',
        PATH: `${fixture}:${process.env.PATH}`,
        PR_NUMBER: '451',
        RUN_URL: 'https://github.com/seandearnaley/brainstrike/actions/runs/123',
      },
    });

    assert.equal(result.status, 1, 'The incomplete-review handler must fail the job visibly.');
    const args = readFileSync(capture, 'utf8');
    assert.equal((args.match(/^pr$/gm) ?? []).length, 1);
    assert.match(args, /^pr\ncomment\n451\n/m);
    assert.match(args, /Claude auto-review did not complete/);
    assert.match(args, /actions\/runs\/123/);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test('review instructions stay on the exact PR diff and approved GitHub surfaces', () => {
  for (const reviewStep of [
    stepNamed('Run primary Claude auto-review'),
    stepNamed('Retry Claude auto-review once'),
  ]) {
    assert.match(reviewStep, /Review only the exact pull request diff returned by `gh pr diff`/);
    assert.match(reviewStep, /Do not inspect or crawl the checked-out repository/);
    assert.match(
      reviewStep,
      /--max-turns 80 --allowedTools "mcp__github_inline_comment__create_inline_comment,Bash\(gh pr comment:\*\),Bash\(gh pr diff:\*\),Bash\(gh pr view:\*\)"/
    );
  }
});
