import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterAllowedFindings, hashSecret, scanText } from '../secret-scan.mjs';

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
