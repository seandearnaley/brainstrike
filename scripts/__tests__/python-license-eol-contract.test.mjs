import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const licensesDir = path.resolve(
  import.meta.dirname,
  '../../apps/desktop/licenses/python-linux-x64'
);
const attributesPath = path.join(licensesDir, '.gitattributes');
const hashes = JSON.parse(readFileSync(path.join(licensesDir, 'sha256.json'), 'utf8'));

function checkoutFilter(t, attributes) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'python-license-eol-'));
  t.after(() => rmSync(fixture, { force: true, recursive: true }));
  mkdirSync(path.join(fixture, 'licenses'));
  writeFileSync(path.join(fixture, 'empty-attributes'), '');
  writeFileSync(path.join(fixture, 'licenses/.gitattributes'), attributes);
  const git = (args, input) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=true',
        '-c',
        `core.attributesFile=${path.join(fixture, 'empty-attributes')}`,
        ...args,
      ],
      { cwd: fixture, env: { ...process.env, GIT_ATTR_NOSYSTEM: '1' }, input }
    );
  git(['init', '--quiet']);
  return (filename, bytes) => {
    const object = git(['hash-object', '-w', '--stdin'], bytes).toString().trim();
    return git(['cat-file', '--filters', `--path=licenses/${filename}`, object]);
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('byte-pinned Python notices survive a core.autocrlf=true checkout unchanged', (t) => {
  const attributes = existsSync(attributesPath) ? readFileSync(attributesPath, 'utf8') : '';
  const checkout = checkoutFilter(t, attributes);
  for (const [filename, expected] of Object.entries(hashes)) {
    const original = readFileSync(path.join(licensesDir, filename));
    assert.equal(sha256(original), expected, `${filename}: source pin`);
    assert.equal(sha256(checkout(filename, original)), expected, `${filename}: checkout pin`);
  }
});

test('CONTROL: removing the attributes changes pinned LF notice bytes at checkout', (t) => {
  const filename = 'LICENSE.cpython.txt';
  const original = readFileSync(path.join(licensesDir, filename));
  const transformed = checkoutFilter(t, '')(filename, original);
  assert.notDeepEqual(transformed, original);
  assert.notEqual(sha256(transformed), hashes[filename]);
  assert.ok(transformed.includes(Buffer.from('\r\n')));
});
