import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

async function installedPreprocessors() {
  const owner = createRequire(new URL('../../packages/assistant-ui/package.json', import.meta.url));
  const entry = owner.resolve('@assistant-ui/react-streamdown');
  return { entry, module: await import(pathToFileURL(entry).href) };
}

const code = String.raw`total = $5 + $10; formula = \(x + 1\);`;

for (const [kind, markdown] of [
  ['indented', `Pricing:\n\n    ${code}\n\nEnd.`],
  ['tab-indented', `\t${code}`],
  ['fenced', `\`\`\`text\n${code}\n\`\`\``],
]) {
  test(`the installed assistant renderer preserves currency and math bytes in ${kind} code`, async () => {
    const { module } = await installedPreprocessors();
    for (const name of ['escapeCurrencyDollars', 'normalizeMathDelimiters']) {
      assert.equal(module[name](markdown), markdown, `${name}: ${kind} code must stay literal`);
    }
  });
}

test('prose preprocessing still works and the adapter shares its canonical implementation', async () => {
  const { entry, module } = await installedPreprocessors();
  const require = createRequire(entry);
  const canonical = await import(
    pathToFileURL(require.resolve('@assistant-ui/react-markdown/preprocess')).href
  );

  assert.equal(module.escapeCurrencyDollars('Costs $5 and $10.'), 'Costs \\$5 and \\$10.');
  assert.equal(module.normalizeMathDelimiters(String.raw`Inline \(x + 1\).`), 'Inline $x + 1$.');
  for (const name of [
    'escapeCurrencyDollars',
    'normalizeMathDelimiters',
    'rewriteCustomMathTags',
    'rewriteLatexBracketDelimiters',
  ]) {
    assert.equal(typeof canonical[name], 'function', `${name} must remain a real preprocessor`);
    assert.equal(module[name], canonical[name], `${name} must use the vendor's single source`);
  }
});
