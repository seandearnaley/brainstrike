import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const workspace = join(import.meta.dirname, '..');

test('the farewell command says goodbye by name', async () => {
  const { run } = await import('../src/commands/farewell.ts');
  assert.equal(run('Ada'), 'Goodbye, Ada!');
});

test('the generated registry is current and lists farewell beside greet', async () => {
  // The generator's own check: its content hash covers every command source,
  // so only running it (not editing the registry by hand) leaves it current.
  execFileSync(process.execPath, ['scripts/build-registry.mjs', '--check'], {
    cwd: workspace,
    stdio: 'pipe',
  });
  const { commands }: { commands: Record<string, (name: string) => string> } = await import(
    '../src/registry.generated.ts'
  );
  assert.deepEqual(Object.keys(commands).sort(), ['farewell', 'greet']);
  assert.equal(commands['farewell']?.('Ada'), 'Goodbye, Ada!');
});

test('a farewell test calls the command through the registry', async () => {
  const written = await readFile(join(workspace, 'test/farewell.test.ts'), 'utf8');
  assert.match(written, /node:test/u);
  assert.match(written, /registry\.generated/u);
  assert.match(written, /farewell/u);
});

test('the changelog lists farewell under Unreleased, above the last release', async () => {
  const changelog = await readFile(join(workspace, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.indexOf('## Unreleased');
  const entry = changelog.indexOf('- Add the farewell command.');
  const released = changelog.indexOf('## 0.1.0');
  assert.ok(unreleased >= 0 && unreleased < entry && entry < released, changelog);
  assert.match(changelog, /- Add the greet command\./u);
});
