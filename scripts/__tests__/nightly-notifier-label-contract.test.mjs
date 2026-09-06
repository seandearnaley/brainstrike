import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const NOTIFIERS = [
  {
    label: 'web-e2e-failure',
    workflow: '.github/workflows/web-e2e.yml',
  },
  {
    label: 'desktop-e2e-failure',
    workflow: '.github/workflows/desktop-e2e.yml',
  },
  {
    label: 'nightly-coverage-failure',
    workflow: '.github/workflows/nightly-coverage.yml',
  },
  {
    label: 'performance-e2e-failure',
    workflow: '.github/workflows/performance.yml',
  },
];

function notifier(config, source = readFileSync(path.join(repoRoot, config.workflow), 'utf8')) {
  const workflow = parseYaml(source);
  const job = workflow.jobs?.['notify-failure'];
  assert.ok(job, `${config.workflow} must define the notify-failure job.`);
  return job;
}

function executableLines(script) {
  return script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function labelScript(config, source) {
  const step = (notifier(config, source).steps ?? []).find((candidate) =>
    /gh label create/.test(candidate.run ?? '')
  );
  assert.ok(step, `${config.workflow} must ensure its tracking label exists.`);
  return executableLines(step.run);
}

function issueScript(config, source) {
  const step = (notifier(config, source).steps ?? []).find((candidate) =>
    /gh issue (?:list|create|comment)/.test(candidate.run ?? '')
  );
  assert.ok(step, `${config.workflow} must open or update a tracking issue.`);
  return executableLines(step.run);
}

for (const config of NOTIFIERS) {
  test(`${config.workflow} makes label creation idempotent and fail-visible`, () => {
    const command = labelScript(config);

    assert.match(command, /set -euo pipefail/, 'the label step must retain strict shell mode.');
    assert.match(command, /gh label create/);
    assert.match(
      command,
      /--force/,
      'an existing label must be updated successfully rather than producing an error to suppress.'
    );
    assert.doesNotMatch(
      command,
      /2>\s*\/dev\/null/,
      'label-create diagnostics must remain visible.'
    );
    assert.doesNotMatch(
      command,
      /\|\|\s*true/,
      'a genuine label-create failure must remain fatal.'
    );
    assert.match(
      command,
      /if\s+!\s+gh label create/,
      'the step must annotate the consequence before exiting on a genuine gh failure.'
    );
    assert.match(command, /::error::.*tracking issue.*filed.*de-duplicated/i);
    assert.match(command, /exit 1/);
  });

  test(`${config.workflow} keeps one open issue per manually closed nightly incident`, () => {
    const command = issueScript(config);

    assert.match(command, /set -euo pipefail/);
    assert.match(command, new RegExp(`--label ["']${config.label}["'] --state open`));
    assert.match(command, /if \[ -n ["']\$existing["'] \]/);
    assert.match(command, /gh issue comment/);
    assert.match(command, /gh issue create/);
    assert.match(
      command,
      /Close it once the next nightly is green\./,
      'nightly incidents remain open until a human confirms recovery; closing one permits a later incident to create a fresh issue.'
    );
  });

  test(`CONTROL: ${config.workflow} rejects swallowed label failures`, () => {
    const source = readFileSync(path.join(repoRoot, config.workflow), 'utf8');
    const marker = `gh label create "${config.label}" \\`;
    const mutated = source.replace(marker, `${marker.slice(0, -1)}2>/dev/null || true \\`);
    assert.notEqual(mutated, source, 'the control mutation matched nothing and would be vacuous.');
    assert.notEqual(
      labelScript(config, mutated),
      labelScript(config, source),
      'the control mutation must change the notifier label step.'
    );

    assert.throws(
      () => assert.doesNotMatch(labelScript(config, mutated), /\|\|\s*true/),
      /expected to not match/i
    );
  });
}
