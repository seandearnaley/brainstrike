import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const COLLECTOR_PATH = fileURLToPath(new URL('./collect-sentinel-evidence.mjs', import.meta.url));

function writeFixtureFile(repo, path, contents = '') {
  const absolutePath = join(repo, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function createFixtureRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'sentinel-test@example.com']);
  git(repo, ['config', 'user.name', 'Sentinel Test']);

  writeFixtureFile(repo, 'AGENTS.md');
  writeFixtureFile(repo, '.night-shift/PROTOCOL.md');
  writeFixtureFile(
    repo,
    '.night-shift/charters/sentinel.md',
    [
      'NAME=Sentinel',
      'CHARTER_VERSION=2',
      'STATE_ISSUE="[automation-state] Sentinel"',
      'LEARNINGS_FILE=".night-shift/sentinel.md"',
      '',
    ].join('\n')
  );
  writeFixtureFile(repo, '.night-shift/sentinel.md', '## Fixture learning\n');
  writeFixtureFile(repo, 'docs/agents/platform-contracts.md');
  writeFixtureFile(repo, 'docs/agents/assistant-providers.md');
  writeFixtureFile(
    repo,
    'scripts/secret-scan.mjs',
    'export function loadConfig() { return {}; }\nexport function scanFileList() { return []; }\n'
  );
  writeFixtureFile(repo, 'secret-scan.config.json', '{}\n');

  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return repo;
}

function createFakeGh(root) {
  const binDirectory = join(root, 'bin');
  const ghPath = join(binDirectory, 'gh');
  mkdirSync(binDirectory);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const pullRequest = (number, headRefName) => ({
  draft: false,
  head: { ref: headRefName, sha: \`sha-\${number}\` },
  html_url: \`https://github.com/seandearnaley/brainstrike/pull/\${number}\`,
  number,
  title: \`PR \${number}\`,
  updated_at: '2026-07-21T00:00:00Z',
  user: { login: 'fixture-author' },
});
const firstPage = Array.from({ length: 100 }, (_, index) =>
  pullRequest(index + 1, \`feature/\${index + 1}\`)
);
firstPage[0].user = null;
const secondPage = [pullRequest(101, 'night-shift/sentinel/existing-hardening')];
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    nameWithOwner: 'seandearnaley/brainstrike',
    url: 'https://github.com/seandearnaley/brainstrike',
  }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('fixture-actor\\n');
  process.exit(0);
}
if (
  args[0] === 'api' &&
  args.includes('--paginate') &&
  args.includes('--slurp') &&
  args.includes('repos/seandearnaley/brainstrike/pulls?state=open&per_page=100')
) {
  process.stdout.write(JSON.stringify([firstPage, secondPage]));
  process.exit(0);
}
process.stderr.write(\`Unexpected gh invocation: \${args.join(' ')}\\n\`);
process.exit(2);
`
  );
  chmodSync(ghPath, 0o755);
  return binDirectory;
}

test('discovers an open Sentinel PR after the first 100 open pull requests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-pagination-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = createFixtureRepo(root);
  const binDirectory = createFakeGh(root);
  const watermark = git(repo, ['rev-parse', 'HEAD']);

  const result = spawnSync(
    process.execPath,
    [COLLECTOR_PATH, '--repo', repo, '--watermark', watermark],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.loopState.openPullRequest?.number, 101);
  assert.equal(
    evidence.loopState.openPullRequest?.headRefName,
    'night-shift/sentinel/existing-hardening'
  );
});
