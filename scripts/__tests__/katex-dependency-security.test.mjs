import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function assertPatched(lock) {
  const versions = Object.keys(lock.packages)
    .filter((key) => key.startsWith('katex@'))
    .map((key) => key.slice('katex@'.length));
  assert.ok(versions.length > 0, 'expected KaTeX in the graph');
  for (const version of versions) {
    assert.match(version, /^0\.\d+\.\d+$/, 'review an unknown KaTeX major');
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(minor > 18 || (minor === 18 && patch >= 2), `vulnerable katex@${version}`);
  }
}

test('the full graph excludes the KaTeX trust-bypass advisory, with negative controls', async () => {
  for (const version of ['0.16.47', '0.17.0', '0.18.0', '0.18.1']) {
    assert.throws(() => assertPatched({ packages: { [`katex@${version}`]: {} } }));
  }
  for (const version of ['0.18.2', '0.18.11', '0.19.0']) {
    assertPatched({ packages: { [`katex@${version}`]: {} } });
  }
  assert.throws(() => assertPatched({ packages: {} }), /expected KaTeX/);
  assert.throws(() => assertPatched({ packages: { 'katex@0.16.47': {}, 'katex@0.18.11': {} } }));
  assertPatched(parsePnpmLockfile(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')));
});

function ownerRequire(owner) {
  const uiRequire = createRequire(path.join(root, 'packages/ui/package.json'));
  if (owner === 'UI') {
    return uiRequire;
  }
  if (owner === 'Mermaid CLI') {
    const rootRequire = createRequire(path.join(root, 'package.json'));
    return createRequire(rootRequire.resolve('@mermaid-js/mermaid-cli'));
  }
  if (owner === 'micromark math') {
    const remarkRequire = createRequire(uiRequire.resolve('remark-math'));
    return createRequire(remarkRequire.resolve('micromark-extension-math'));
  }
  return createRequire(uiRequire.resolve(owner === 'rehype math' ? 'rehype-katex' : 'mermaid'));
}

for (const owner of [
  'UI',
  'rehype math',
  'micromark math',
  'Mermaid',
  'Mermaid CLI',
  'Mermaid bundle',
]) {
  test(`${owner} ignores inherited trust and preserves safe rendering and strict errors`, async () => {
    let moduleUrl;
    if (owner === 'Mermaid bundle') {
      const uiRequire = ownerRequire('UI');
      const chunks = path.join(path.dirname(uiRequire.resolve('mermaid')), 'chunks/mermaid.esm');
      const files = (await readdir(chunks)).filter((name) => /^katex-.*\.mjs$/.test(name));
      assert.equal(files.length, 1, 'review a changed Mermaid bundle layout');
      moduleUrl = pathToFileURL(path.join(chunks, files[0])).href;
    } else {
      moduleUrl = pathToFileURL(ownerRequire(owner).resolve('katex')).href;
    }
    // Prototype mutation stays in a disposable process, away from the test runner.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      const { default: katex } = await import(${JSON.stringify(moduleUrl)});
      const expression = String.raw\`\\href{javascript:alert(1)}{unsafe}\`;
      Object.defineProperty(Object.prototype, 'trust', { value: true, writable: true, configurable: true });
      try {
        const html = katex.renderToString(expression, { throwOnError: false });
        assert.ok(!html.includes('href="javascript:'), 'inherited trust must never enable unsafe links');
      } finally {
        delete Object.prototype.trust;
      }
      const html = katex.renderToString(String.raw\`\\frac{a+b}{c} + \\sqrt{x}\`, { displayMode: true });
      assert.ok(html.includes('katex-display') && html.includes('<math') && html.includes('katex-base'));
      assert.throws(() => katex.renderToString(String.raw\`\\notARealMathCommand\`), katex.ParseError);
      const warnings = [];
      katex.renderToString('😀', { strict: code => { warnings.push(code); return 'ignore'; } });
      assert.ok(warnings.includes('symbolNotInFont'), 'qualify the 0.19 strict callback change');
      assert.throws(() => katex.renderToString('😀', { strict: 'error' }), katex.ParseError);
      const messages = [];
      const warn = console.warn;
      console.warn = message => messages.push(message);
      try {
        katex.renderToString('😀', { strict: () => undefined });
        assert.ok(messages.some(message => message.includes('symbolNotInFont')),
          'undefined strict callbacks must warn, not silently ignore missing glyphs');
      } finally {
        console.warn = warn;
      }
    `,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}
