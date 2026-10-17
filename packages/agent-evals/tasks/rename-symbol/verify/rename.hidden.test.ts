import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const src = join(import.meta.dirname, '../src');

test('no file under src/ names calcArea any more', async () => {
  for (const file of await readdir(src, { recursive: true })) {
    if (file.endsWith('.ts')) {
      assert.doesNotMatch(await readFile(join(src, file), 'utf8'), /calcArea/u, file);
    }
  }
});

test('the package exports rectangleArea with unchanged behavior', async () => {
  const exported: Record<string, unknown> = await import('../src/index.ts');
  assert.equal(typeof exported['rectangleArea'], 'function');
  assert.equal(exported['calcArea'], undefined);
  const { rectangleArea } = await import('../src/geometry.ts');
  assert.equal(rectangleArea(3, 4), 12);
});

test('the report still computes each room through the renamed function', async () => {
  const { floorReport } = await import('../src/report.ts');
  assert.equal(
    floorReport([
      { depth: 4, name: 'Kitchen', width: 3 },
      { depth: 2, name: 'Hall', width: 5 },
    ]),
    'Kitchen: 12 m2\nHall: 10 m2'
  );
});
