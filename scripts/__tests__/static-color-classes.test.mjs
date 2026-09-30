import assert from 'node:assert/strict';
import { it } from 'node:test';
import { staticClassStrings, staticColorClasses } from '../lib/static-color-classes.mjs';

it('reads literals, conditional branches and static template segments, excluding comments/prose', () => {
  const source = [
    '// text-red-500 is deliberately not executable',
    'const colors = { ok: "text-green-600", bad: `text-red-500` };',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Parser fixture must preserve the interpolation as source text.
    'const view = <span className={`hover:text-amber-500 ${ok ? "text-sky-500" : "text-red-600"}`}>text-orange-500</span>;',
  ].join('\n');
  assert.deepEqual(
    staticColorClasses(source).map(({ utility }) => utility),
    ['text-green-600', 'text-red-500', 'hover:text-amber-500', 'text-sky-500', 'text-red-600']
  );
});

it('fails closed for syntax errors and does not claim dynamic fragments are classes', () => {
  assert.throws(() => staticColorClasses('const view = <span'), /Cannot parse/);
  assert.deepEqual(staticColorClasses('const color = "text-" + family + "-500";'), []);
});

it('does not treat tokens touching template interpolation as complete static classes', () => {
  const source =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Parser fixture must preserve the interpolation as source text.
    'const classes = `text-slate-900${alpha} text-green-600 ${prefix}text-red-500 hover:text-sky-500 ${suffix}`;';
  assert.deepEqual(
    staticColorClasses(source).map(({ utility }) => utility),
    ['text-green-600', 'hover:text-sky-500']
  );
});

it('parses TypeScript generics as TypeScript in non-JSX source files', () => {
  assert.deepEqual(
    staticColorClasses(
      'const identity = <T>(value: T) => value; const color = "text-red-500";',
      'colors.ts'
    ).map(({ utility }) => utility),
    ['text-red-500']
  );
});

it('associates literal class names with current JSX elements and direct ancestors only', () => {
  const records = staticClassStrings(
    '<section className="bg-black"><><div><p className={"text-slate-200"} title="text-red-200" /></div></></section>'
  );
  const foreground = records.find(({ literal }) => literal === 'text-slate-200');
  assert.deepEqual(
    foreground.jsxPath.map(({ element, literal }) => [element, literal]),
    [
      ['p', 'text-slate-200'],
      ['div', ''],
      ['section', 'bg-black'],
    ]
  );
  assert.deepEqual(records.find(({ literal }) => literal === 'text-red-200').jsxPath, []);
});

it('marks dynamic classes, inline styles and spreads as unresolved paint metadata', () => {
  for (const attributes of [
    'className={classes}',
    'style={{ background: "white" }}',
    '{...props}',
  ]) {
    const records = staticClassStrings(
      `<div ${attributes}><span className="text-slate-200" /></div>`
    );
    const foreground = records.find(({ literal }) => literal === 'text-slate-200');
    assert.equal(foreground.jsxPath[1].unresolved, true, attributes);
  }
});
