import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/claude-code-review.yml', 'utf8');

test('Claude orchestration uses trusted default-branch code for automatic and targeted review', () => {
  assert.match(workflow, /^ {2}pull_request_target:/m);
  assert.doesNotMatch(workflow, /^ {2}pull_request:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.match(workflow, /expected_head:/);
  assert.match(workflow, /focus:/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref:.*pull_request.head/);
});

test('review authenticates without the App exchange that rejects pull_request_target', () => {
  // Anthropic's github-app-token-exchange 401s on a pull_request_target OIDC
  // token (anthropics/claude-code-action#713), so the App path cannot run here.
  // The action must receive the workflow's own token and nothing broader, and
  // the now-unusable OIDC grant must stay off the job.
  assert.match(workflow, /github_token: \$\{\{ github.token \}\}/);
  assert.doesNotMatch(workflow, /github_token: \$\{\{ secrets\./);
  assert.doesNotMatch(workflow, /id-token:/);
});

test('reporting always consumes explicit Claude conclusion instead of green eligibility', () => {
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /ACTION_CONCLUSION: \$\{\{ steps.claude-review.outputs.conclusion \}\}/);
  assert.match(
    workflow,
    /REVIEW_OUTPUT: \$\{\{ steps.claude-review.outputs.structured_output \}\}/
  );
  assert.match(workflow, /ACTION_OUTCOME: \$\{\{ steps.claude-review.outcome \}\}/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /node scripts\/claude-review.mjs report/);
});

test('review reads captured diff and preserves bounded lifecycle and targeted dispatch', () => {
  assert.match(workflow, /types: \[opened, ready_for_review, reopened\]/);
  assert.doesNotMatch(workflow, /types:.*synchronize/);
  assert.match(workflow, /prompt: \$\{\{ steps.request.outputs.prompt \}\}/);
  assert.match(workflow, /claude_args: \$\{\{ steps.request.outputs.claude_args \}\}/);
});
