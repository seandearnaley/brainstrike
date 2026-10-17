import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const workspace = join(import.meta.dirname, '..');

test('farewell says goodbye by name', async () => {
  const { farewell } = await import('../src/farewell.ts');
  assert.equal(farewell('Ada'), 'Goodbye, Ada!');
});

test('the package exports farewell beside greet', async () => {
  const exported: Record<string, unknown> = await import('../src/index.ts');
  assert.equal(typeof exported['farewell'], 'function');
  assert.equal(typeof exported['greet'], 'function');
});

test('a farewell test sits beside the greet test', async () => {
  const written = await readFile(join(workspace, 'test/farewell.test.ts'), 'utf8');
  assert.match(written, /node:test/u);
  assert.match(written, /farewell/u);
});

test('the changelog lists farewell under Unreleased, above the last release', async () => {
  const changelog = await readFile(join(workspace, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.indexOf('## Unreleased');
  const entry = changelog.indexOf('- Add farewell(name).');
  const released = changelog.indexOf('## 0.1.0');
  assert.ok(unreleased >= 0 && unreleased < entry && entry < released, changelog);
  assert.match(changelog, /- Add greet\(name\)\./u);
});
