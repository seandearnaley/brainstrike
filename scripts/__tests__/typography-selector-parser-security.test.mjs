import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function assertPatchedVersion(version) {
  assert.match(version, /^7\.\d+\.\d+$/, 'review an unqualified selector-parser major');
  const [, minor, patch] = version.split('.').map(Number);
  assert.ok(minor > 1 || (minor === 1 && patch >= 6), `vulnerable selector-parser@${version}`);
}

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('postcss-selector-parser@'))
    .map((key) => key.slice('postcss-selector-parser@'.length));
  assert.ok(versions.length > 0, 'expected selector-parser in the graph');
  for (const version of versions) {
    assertPatchedVersion(version);
  }
}

test('the full graph excludes selector-parser advisory ranges', async () => {
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
});

test('the graph guard rejects vulnerable, missing and unqualified releases', () => {
  const fixture = (...versions) => ({
    packages: Object.fromEntries(
      versions.map((version) => [`postcss-selector-parser@${version}`, {}])
    ),
  });
  for (const version of ['6.0.10', '6.1.2', '7.0.0', '7.1.3', '7.1.5', '8.0.0']) {
    assert.throws(() => assertPatched(fixture(version)));
  }
  assert.throws(() => assertPatched(fixture()), /expected selector-parser/);
  assert.throws(() => assertPatched(fixture('7.1.6', '6.0.10')));
  assertPatched(fixture('7.1.6', '7.2.0'));
});

for (const app of ['web', 'desktop']) {
  function appRequire() {
    return createRequire(path.join(root, `apps/${app}/package.json`));
  }

  test(`${app} typography preserves trailing pseudo-elements, nested selectors and escapes`, () => {
    const ownerRequire = appRequire();
    const { commonTrailingPseudos } = ownerRequire('@tailwindcss/typography/src/utils.js');
    for (const [selector, expected] of [
      ['p::before,blockquote::before', ['::before', 'p,blockquote']],
      ['li::marker', ['::marker', 'li']],
      ['code::before,code::after', [null, 'code::before,code::after']],
      [
        'pre code:not([class~="not-prose"])::before',
        ['::before', 'pre code:not([class~="not-prose"])'],
      ],
      ['a\\:link::after', ['::after', 'a\\:link']],
    ]) {
      assert.deepEqual(commonTrailingPseudos(selector), expected);
    }
  });

  test(`${app} typography bounds the vendor's 400 KB flat-selector attack`, () => {
    const typographyRequire = createRequire(appRequire().resolve('@tailwindcss/typography'));
    const entry = typographyRequire.resolve('./utils.js');
    // GHSA-rj75-hqrm-r3gf: old quadratic parsing takes tens of seconds. A
    // disposable process bounds the reproduction without blocking the runner.
    const result = spawnSync(
      process.execPath,
      [
        '--eval',
        `
      const assert = require('node:assert/strict');
      const { commonTrailingPseudos } = require(${JSON.stringify(entry)});
      const selector = '.a'.repeat(200000);
      assert.deepEqual(commonTrailingPseudos(selector), [null, selector]);
    `,
      ],
      { encoding: 'utf8', timeout: 3000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${app}'s Tailwind compiler builds prose, dark and element variants with the installed plugin`, async () => {
    const ownerRequire = appRequire();
    const viteRequire = createRequire(ownerRequire.resolve('@tailwindcss/vite'));
    const { compile } = viteRequire('@tailwindcss/node');
    const dependencies = [];
    // Use the real app's compiler and plugin resolution, without requiring
    // unrelated workspace dist CSS or a complete application build.
    const compiler = await compile(
      '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n@custom-variant dark (&:is(.dark *));',
      { base: path.join(root, `apps/${app}`), onDependency: (file) => dependencies.push(file) }
    );
    const css = compiler.build([
      'prose',
      'prose-sm',
      'prose-invert',
      'dark:prose-invert',
      'prose-headings:font-semibold',
      'prose-a:text-sky-600',
    ]);
    assert.ok(dependencies.length > 0, 'compiler must load its real CSS imports');
    for (const selector of [
      '.prose {',
      '.prose-sm {',
      '.prose-invert {',
      '.dark\\:prose-invert:is(.dark *) {',
      ':where(blockquote p:first-of-type):not(:where([class~="not-prose"], [class~="not-prose"] *))::before',
      ':where(code):not(:where([class~="not-prose"], [class~="not-prose"] *))::after',
      '.prose-headings\\:font-semibold :is(',
      '.prose-a\\:text-sky-600 :is(',
    ]) {
      assert.ok(css.includes(selector), `missing generated selector: ${selector}`);
    }
  });
}
