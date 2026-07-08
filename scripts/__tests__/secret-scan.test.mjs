import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { filterAllowedFindings, hashSecret, scanFileList, scanText } from '../secret-scan.mjs';

const secretScanCliPath = fileURLToPath(new URL('../secret-scan.mjs', import.meta.url));

function createGitFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'brainstrike-secret-scan-'));
  spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
  return cwd;
}

function runSecretScan(args, cwd) {
  return spawnSync(process.execPath, [secretScanCliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('scanText detects high-confidence credential patterns', () => {
  const findings = scanText({
    filePath: 'fixture.env',
    text: [
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
    ].join('\n'),
  });

  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['openai-api-key', 'aws-access-key-id']
  );
  assert.equal(findings[0].filePath, 'fixture.env');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[1].line, 2);
});

test('scanText ignores placeholder and redacted examples', () => {
  const findings = scanText({
    filePath: 'docs/example.md',
    text: [
      'OPENAI_API_KEY=sk-REDACTED',
      'AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxx',
      'GITHUB_TOKEN=ghp_exampletoken',
    ].join('\n'),
  });

  assert.deepEqual(findings, []);
});

test('scanText detects current OpenAI project and service account key formats', () => {
  const findings = scanText({
    filePath: 'fixture.env',
    text: [
      'OPENAI_PROJECT_KEY=sk-proj-abcDEF123_ghiJKL456-mnoPQR789_stuVWX012',
      'OPENAI_SERVICE_KEY=sk-svcacct-abcDEF123_ghiJKL456-mnoPQR789_stuVWX012',
    ].join('\n'),
  });

  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['openai-api-key', 'openai-api-key']
  );
});

test('scanText detects fine-grained GitHub personal access tokens', () => {
  const findings = scanText({
    filePath: 'fixture.env',
    text: [
      'GITHUB_TOKEN=github_pat_11AAAAAAA0AAAAAAA0AAAA_',
      'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ].join(''),
  });

  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['github-token']
  );
});

test('scanText detects Hugging Face access tokens', () => {
  const findings = scanText({
    filePath: 'fixture.env',
    text: 'HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz12345678',
  });

  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['hugging-face-token']
  );
});

test('filterAllowedFindings suppresses reviewed hashes only for matching files and rules', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const findings = scanText({
    filePath: 'fixture.env',
    text: `OPENAI_API_KEY=${secret}`,
  });

  assert.equal(findings.length, 1);

  const filtered = filterAllowedFindings(findings, {
    allowlistedFindings: [
      {
        filePath: 'fixture.env',
        reason: 'Documented false positive in a fixture',
        ruleId: 'openai-api-key',
        secretHash: hashSecret(secret),
      },
    ],
    excludePaths: [],
  });

  assert.deepEqual(filtered, []);
});

test('filterAllowedFindings keeps findings when allowlist metadata does not match', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const findings = scanText({
    filePath: 'fixture.env',
    text: `OPENAI_API_KEY=${secret}`,
  });

  const filtered = filterAllowedFindings(findings, {
    allowlistedFindings: [
      {
        filePath: 'other.env',
        reason: 'Wrong file should not suppress this finding',
        ruleId: 'openai-api-key',
        secretHash: hashSecret(secret),
      },
    ],
    excludePaths: [],
  });

  assert.equal(filtered.length, 1);
});

test('--all skips tracked binary files before scanning contents', () => {
  const cwd = createGitFixture();
  try {
    writeFileSync(
      join(cwd, 'binary.dat'),
      Buffer.from([0, ...Buffer.from('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456'), 0])
    );
    spawnSync('git', ['add', 'binary.dat'], { cwd, encoding: 'utf8' });

    const result = runSecretScan(['--all'], cwd);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Secret scan passed/);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('--staged scans large lockfile-sized text files without overflowing git output buffers', () => {
  const cwd = createGitFixture();
  try {
    writeFileSync(join(cwd, 'large-lock.yaml'), `${'package:\n'.repeat(160_000)}\n`);
    spawnSync('git', ['add', 'large-lock.yaml'], { cwd, encoding: 'utf8' });

    const result = runSecretScan(['--staged'], cwd);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Secret scan passed/);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test('scanFileList skips expected missing-file read failures', () => {
  const readError = Object.assign(new Error('file disappeared'), {
    code: 'ENOENT',
  });

  const findings = scanFileList({
    config: { allowlistedFindings: [], excludePaths: [] },
    files: ['missing.env'],
    readFile() {
      throw readError;
    },
  });

  assert.deepEqual(findings, []);
});

test('scanFileList surfaces unexpected reader failures', () => {
  assert.throws(
    () =>
      scanFileList({
        config: { allowlistedFindings: [], excludePaths: [] },
        files: ['fixture.env'],
        readFile() {
          throw new TypeError('reader bug');
        },
      }),
    /reader bug/
  );
});
