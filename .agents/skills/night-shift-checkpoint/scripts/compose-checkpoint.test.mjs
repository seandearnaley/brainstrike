import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'compose-checkpoint.mjs');
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function compose(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('composes and validates a sha-watermark checkpoint line', () => {
  const result = compose([
    '--timestamp',
    '2026-08-01T12:00:00Z',
    '--watermark',
    `sha:${SHA}`,
    '--status',
    'NOOP',
    '--message',
    'nothing new since watermark',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `2026-08-01T12:00:00Z | watermark=sha:${SHA} | status=NOOP | nothing new since watermark\n`
  );
});

test('defaults the timestamp to second-precision UTC now', () => {
  const result = compose([
    '--watermark',
    `hash:${HASH}`,
    '--status',
    'READY',
    '--message',
    'PR #1 stable',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \| watermark=hash:/);
});

test('rejects a malformed watermark via the validator', () => {
  const result = compose([
    '--watermark',
    'sha:not-a-sha',
    '--status',
    'NOOP',
    '--message',
    'x',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /watermark/);
});

test('rejects a multi-line or pipe-carrying message before composing', () => {
  for (const message of ['two\nlines', 'has | pipe']) {
    const result = compose([
      '--watermark',
      `sha:${SHA}`,
      '--status',
      'NOOP',
      '--message',
      message,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /one line/);
  }
});

test('passes --posted-this-run through to the validator supersedes rule', () => {
  const result = compose([
    '--timestamp',
    '2026-08-01T12:05:00Z',
    '--watermark',
    `sha:${SHA}`,
    '--status',
    'NOOP',
    '--message',
    'second line without supersedes',
    '--posted-this-run',
    '2026-08-01T12:00:00Z',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supersedes/);
});
