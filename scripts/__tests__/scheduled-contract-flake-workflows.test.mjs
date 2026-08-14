import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cases = [
  ['contract-drift-guardian.yml', '11 9 * * 1', 40, 'contract-drift/cli.mjs'],
  ['ci-flake-investigator.yml', '29 9 * * 3', 50, 'ci-flake/cli.mjs'],
];

for (const [file, cron, timeout, entry] of cases) {
  test(`${file} is bounded, report-only, and always uploads evidence`, () => {
    const text = readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    const parsed = YAML.parse(text);
    assert.equal(parsed.permissions.contents, 'read');
    assert.equal(
      parsed.permissions.actions,
      file === 'ci-flake-investigator.yml' ? 'read' : undefined
    );
    assert.deepEqual(Object.keys(parsed.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.equal(parsed.on.schedule[0].cron, cron);
    assert.doesNotMatch(
      text,
      /pull_request_target|issues:\s*write|contents:\s*write|git push|gh pr|merge|deploy/u
    );
    const jobs = Object.values(parsed.jobs);
    assert.ok(jobs.every((job) => job['timeout-minutes'] === timeout));
    assert.match(text, new RegExp(entry.replace('.', '\\.')));
    assert.match(text, /actions\/upload-artifact@v7/u);
    assert.match(text, /if:\s*always\(\)/u);
    assert.match(text, /if-no-files-found:\s*error/u);
    assert.match(
      text,
      /if: github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/u
    );
    assert.match(text, /ref: refs\/heads\/main/u);
    assert.match(text, /fetch-depth: 0/u);
    assert.match(text, /uses: \.\/\.github\/actions\/setup-report-workspace/u);
    assert.doesNotMatch(text, /setup-workspace|actions\/cache|turbo-cache/u);
  });
}

test('flake investigation is one metadata-selected job, never a blind shard matrix', () => {
  const text = readFileSync(path.join(root, '.github/workflows/ci-flake-investigator.yml'), 'utf8');
  const parsed = YAML.parse(text);
  const [job] = Object.values(parsed.jobs);
  assert.equal(job.strategy, undefined);
  assert.equal(job.env.GITHUB_TOKEN, ['$', '{{ github.token }}'].join(''));
  assert.doesNotMatch(text, /matrix:|UNIT_SHARD|three uncached attempts per Unit phase/u);
});
