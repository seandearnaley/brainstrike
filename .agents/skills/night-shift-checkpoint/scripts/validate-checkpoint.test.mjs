import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'validate-checkpoint.mjs'
);

const SHA_LINE =
  '2026-07-23T04:07:00Z | watermark=sha:2f5a1c9e8b7d6a4f3e2d1c0b9a8f7e6d5c4b3a21 | status=NOOP | delta empty, no open PR';
const HASH_LINE =
  '2026-07-23T10:13:00Z | watermark=hash:9b74c9897bac770ffc029102a200c5de13f7fe1a1f5e0c4b2a3d4e5f6a7b8c9d | status=BLOCKED | waiting on BST-695 reproduction evidence';

function validate(...args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

test('accepts a MAIN-DIFF checkpoint with a typed sha watermark', () => {
  const result = validate(SHA_LINE);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'valid\n');
});

test('accepts an EXTERNAL-STATE checkpoint with a typed hash watermark', () => {
  const result = validate(HASH_LINE);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts watermark=none for a first run', () => {
  const result = validate(
    '2026-07-23T04:07:00Z | watermark=none | status=NOOP | first wake, empty watermark'
  );
  assert.equal(result.status, 0, result.stderr);
});

test('accepts a message containing pipe separators', () => {
  const result = validate(
    '2026-07-23T04:07:00Z | watermark=none | status=INCOMPLETE | next: reconcile PR #1903 | then re-run gates'
  );
  assert.equal(result.status, 0, result.stderr);
});

test('rejects millisecond-precision timestamps', () => {
  const result = validate(SHA_LINE.replace('04:07:00Z', '04:07:00.123Z'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timestamp/u);
});

test('rejects timestamps without a Z suffix', () => {
  const result = validate(SHA_LINE.replace('04:07:00Z', '04:07:00+00:00'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timestamp/u);
});

test('rejects calendar-invalid timestamps', () => {
  const result = validate(SHA_LINE.replace('2026-07-23', '2026-02-30'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timestamp/u);
});

test('rejects a legacy untyped bare-sha watermark', () => {
  const result = validate(SHA_LINE.replace('watermark=sha:', 'watermark='));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /watermark/u);
});

test('rejects a sha watermark of the wrong length', () => {
  const result = validate(
    SHA_LINE.replace(
      'watermark=sha:2f5a1c9e8b7d6a4f3e2d1c0b9a8f7e6d5c4b3a21',
      'watermark=sha:2f5a1c9e'
    )
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /watermark/u);
});

test('rejects an unknown status', () => {
  const result = validate(SHA_LINE.replace('status=NOOP', 'status=DONE'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /status/u);
});

test('rejects an empty message', () => {
  const result = validate(SHA_LINE.replace(/\| delta empty.*$/u, '| '));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /message/u);
});

test('rejects a multi-line checkpoint', () => {
  const result = validate(`${SHA_LINE}\nsecond line`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /single line/u);
});

test('rejects a message over 300 characters', () => {
  const result = validate(SHA_LINE.replace('delta empty, no open PR', 'x'.repeat(301)));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /message/u);
});

test('rejects a line missing a field', () => {
  const result = validate('2026-07-23T04:07:00Z | status=NOOP | missing watermark field');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shape/u);
});

test('rejects invocation without exactly one argument', () => {
  const none = validate();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /exactly one/u);

  const two = validate('a', 'b');
  assert.equal(two.status, 1);
  assert.match(two.stderr, /exactly one/u);
});

test('rejects an unsupported flag', () => {
  const result = validate('--freeze', SHA_LINE);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported argument/u);
});

// Run boundaries (PROTOCOL.md "Run boundaries"). A second checkpoint inside one
// run is legitimate only as an explicit correction of a line that was already
// wrong when posted — never because the watched set moved while the loop worked.

const CORRECTION_LINE =
  '2026-07-25T04:21:27Z | watermark=none | status=PR | supersedes=2026-07-25T04:17:48Z status was misstated as NOOP';

test('accepts a supersedes token naming an earlier instant', () => {
  const result = validate(CORRECTION_LINE);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a supersedes token that is not a second-precision UTC instant', () => {
  for (const value of ['2026-07-25T04:17:48.500Z', '2026-07-25T04:17:48', 'earlier-today']) {
    const result = validate(CORRECTION_LINE.replace('2026-07-25T04:17:48Z', value));
    assert.equal(result.status, 1, `${value} should be rejected`);
    assert.match(result.stderr, /supersedes/u);
  }
});

test('rejects a supersedes token at or after the line it is posted on', () => {
  for (const value of ['2026-07-25T04:21:27Z', '2026-07-25T05:00:00Z']) {
    const result = validate(
      CORRECTION_LINE.replace('supersedes=2026-07-25T04:17:48Z', `supersedes=${value}`)
    );
    assert.equal(result.status, 1, `${value} should be rejected`);
    assert.match(result.stderr, /earlier/u);
  }
});

test('rejects more than one supersedes token', () => {
  const result = validate(
    CORRECTION_LINE.replace(
      'supersedes=2026-07-25T04:17:48Z',
      'supersedes=2026-07-25T04:17:48Z supersedes=2026-07-25T04:19:04Z'
    )
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /more than one supersedes/u);
});

test('rejects a second same-run checkpoint that does not declare a correction', () => {
  const result = validate(
    '--posted-this-run',
    '2026-07-25T04:17:48Z',
    '2026-07-25T04:21:27Z | watermark=none | status=PR | graded #1982 after its head moved'
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already posted a checkpoint/u);
  assert.match(result.stderr, /supersedes=2026-07-25T04:17:48Z/u);
});

test('rejects a same-run correction that names the wrong prior checkpoint', () => {
  const result = validate(
    '--posted-this-run',
    '2026-07-25T04:17:48Z',
    CORRECTION_LINE.replace('supersedes=2026-07-25T04:17:48Z', 'supersedes=2026-07-25T04:19:04Z')
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must name the checkpoint this run already posted/u);
});

test('accepts a same-run correction that names the prior checkpoint exactly', () => {
  const result = validate('--posted-this-run', '2026-07-25T04:17:48Z', CORRECTION_LINE);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'valid\n');
});

test('rejects a missing or malformed --posted-this-run value', () => {
  const missing = validate('--posted-this-run');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--posted-this-run requires/u);

  const malformed = validate('--posted-this-run', '2026-07-25T04:17:48', CORRECTION_LINE);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /--posted-this-run/u);
});
