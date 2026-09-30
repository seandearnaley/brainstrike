import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { it } from 'node:test';
import ts from 'typescript';
import { composite, contrastRatio, hslToRgb, oklchToRgb } from '../lib/color-contrast.mjs';
import { themeModes } from '../lib/semantic-theme-contract.mjs';

const root = join(import.meta.dirname, '..', '..');
const modes = themeModes(readFileSync(join(root, 'packages/ui/src/globals.css'), 'utf8'));
const surfaces = [
  'background',
  'card',
  'popover',
  'muted',
  'secondary',
  'accent',
  'sidebar',
  'sidebar-accent',
];
const require = createRequire(join(root, 'packages/ui/package.json'));
const palette = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');

function semantic(tokens, name) {
  const value = tokens.get(`--bs-${name}`);
  assert.ok(value, `Missing semantic color ${name}`);
  return hslToRgb(value.replaceAll('%', '').split(/\s+/).map(Number));
}

function destructiveVariant(path) {
  const file = ts.createSourceFile(
    path,
    readFileSync(join(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'destructive' &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      found.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(found.length, 1, `Exactly one destructive variant in ${path}`);
  return found[0].split(/\s+/);
}

function destructiveBackgrounds(classes) {
  // Qualify every background utility, not only the expected token family.
  // New background images/positions or arbitrary colors need an explicit paint model.
  // Leading/trailing ! is deliberately unsupported: this model does not resolve cascade priority.
  const backgrounds = classes.filter((utility) => /(?:^|:)!?bg-/.test(utility));
  for (const utility of backgrounds) {
    assert.ok(
      !/(?:^|:)!bg-|!$/.test(utility),
      `Unsupported important background utility: ${utility}; qualify its cascade before measuring contrast`
    );
    assert.match(
      utility,
      /(?:^|:)bg-destructive(?:\/\d+)?$/,
      `Unqualified destructive background override: ${utility}`
    );
  }
  return backgrounds;
}

function destructiveFillAlphas(classes, mode) {
  return destructiveBackgrounds(classes).flatMap((utility) => {
    if (utility.startsWith('dark:') && !mode.endsWith('dark')) {
      return [];
    }
    const match = utility.match(/(?:^|:)bg-destructive(?:\/(\d+))?$/);
    return match ? [match[1] ? Number(match[1]) / 100 : 1] : [];
  });
}

for (const path of ['packages/ui/src/button.tsx', 'packages/ui/src/badge.tsx']) {
  it(`${path} keeps its actual filled variants legible, including dark and hover alpha`, () => {
    const classes = destructiveVariant(path);
    assert.ok(classes.includes('text-destructive-foreground'));
    for (const [mode, tokens] of Object.entries(modes)) {
      const alphas = destructiveFillAlphas(classes, mode);
      assert.ok(alphas.length > 0);
      for (const surface of surfaces) {
        for (const alpha of alphas) {
          const fill = composite(semantic(tokens, 'destructive'), semantic(tokens, surface), alpha);
          const ratio = contrastRatio(semantic(tokens, 'destructive-foreground'), fill);
          assert.ok(
            ratio >= 4.5,
            `${path}: ${mode}/${surface} alpha ${alpha}: ${ratio.toFixed(4)}:1`
          );
        }
      }
    }
  });
}

function toastCloseClasses() {
  const path = 'packages/ui/src/toast.tsx';
  const file = ts.createSourceFile(
    path,
    readFileSync(join(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let classes;
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(file) === 'ToastPrimitives.Close'
    ) {
      const attribute = node.attributes.properties.find(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText(file) === 'className'
      );
      const expression = attribute?.initializer?.expression;
      assert.ok(expression && ts.isCallExpression(expression));
      const literal = expression.arguments[0];
      assert.ok(literal && ts.isStringLiteralLike(literal));
      classes = literal.text.split(/\s+/);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(classes, 'Live ToastClose class string must be inspected');
  return classes;
}

function requireOpaqueToastFill(classes) {
  const fills = destructiveBackgrounds(classes);
  assert.deepEqual(
    fills,
    ['bg-destructive'],
    'Toast paint measurement requires its actual opaque destructive fill; alpha or variant overrides must be qualified'
  );
  return 'destructive';
}

it('rejects an alpha or theme override in the actual Toast fill contract', () => {
  assert.throws(() => requireOpaqueToastFill(['bg-destructive/60']), /opaque destructive fill/);
  assert.throws(
    () => requireOpaqueToastFill(['bg-destructive', 'dark:bg-destructive/60']),
    /opaque destructive fill/
  );
});

for (const utility of [
  '!bg-destructive',
  'bg-destructive!',
  'hover:!bg-destructive/90',
  'hover:bg-destructive/90!',
  'dark:!bg-destructive/60',
  'dark:bg-destructive/60!',
  'dark:hover:!bg-destructive/90',
  'dark:hover:bg-destructive/90!',
  '!bg-red-700',
  'bg-red-700!',
  'hover:!bg-info',
  'hover:bg-info!',
]) {
  it(`explicitly rejects unsupported important background ${utility} before measuring fills`, () => {
    const classes = ['bg-destructive', utility];
    const expected = {
      message: `Unsupported important background utility: ${utility}; qualify its cascade before measuring contrast`,
    };
    assert.throws(() => destructiveBackgrounds(classes), expected);
    assert.throws(() => requireOpaqueToastFill(classes), expected);
    for (const mode of Object.keys(modes)) {
      assert.throws(() => destructiveFillAlphas(classes, mode), expected);
    }
  });
}

function closePaint(tokens, color) {
  if (color === 'destructive-foreground') {
    return semantic(tokens, color);
  }
  const match = palette.match(
    new RegExp(`--color-${color}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`)
  );
  assert.ok(match, `Unsupported live close color ${color}`);
  return oklchToRgb([Number(match[1]) / 100, Number(match[2]), Number(match[3])]);
}

it('the actual destructive ToastClose focus ring clears 3:1 in every mode', () => {
  const classes = toastCloseClasses();
  const prefix = 'focus-visible:group-[.destructive]:ring-';
  const ring = classes.find(
    (utility) => utility.startsWith(prefix) && !utility.startsWith(`${prefix}offset-`)
  );
  assert.ok(ring, 'Missing qualified destructive focus ring');
  const fillName = requireOpaqueToastFill(destructiveVariant('packages/ui/src/toast.tsx'));
  for (const [mode, tokens] of Object.entries(modes)) {
    const ratio = contrastRatio(
      closePaint(tokens, ring.slice(prefix.length)),
      semantic(tokens, fillName)
    );
    assert.ok(ratio >= 3, `${mode} focus ring ${ring}: ${ratio.toFixed(4)}:1`);
  }
});

it('the live destructive ToastClose glyph clears 3:1 at resting and hover opacity in every mode', () => {
  const classes = toastCloseClasses();
  const fillName = requireOpaqueToastFill(destructiveVariant('packages/ui/src/toast.tsx'));
  const states = [
    { alpha: 0.7, prefix: 'group-[.destructive]:text-' },
    { alpha: 1, prefix: 'hover:group-[.destructive]:text-' },
  ];
  assert.ok(classes.includes('opacity-70'));
  assert.ok(classes.includes('hover:opacity-100'));
  for (const state of states) {
    const utility = classes.find((item) => item.startsWith(state.prefix));
    assert.ok(utility, `Missing qualified close color for ${state.prefix}`);
    const color = utility.slice(state.prefix.length);
    for (const [mode, tokens] of Object.entries(modes)) {
      const foreground = closePaint(tokens, color);
      const fill = semantic(tokens, fillName);
      const ratio = contrastRatio(composite(foreground, fill, state.alpha), fill);
      assert.ok(ratio >= 3, `${mode} ${utility} alpha ${state.alpha}: ${ratio.toFixed(4)}:1`);
    }
  }
});

for (const path of [
  'packages/ui/src/button.tsx',
  'packages/ui/src/badge.tsx',
  'packages/ui/src/toast.tsx',
]) {
  it(`${path} rejects a different background family instead of measuring the wrong fill`, () => {
    const classes = destructiveVariant(path);
    for (const override of [
      'bg-red-700',
      'dark:bg-red-700',
      'hover:bg-info',
      'bg-[black]',
      'dark:!bg-red-700',
    ]) {
      const changed = [...classes, override];
      if (path.endsWith('/toast.tsx')) {
        assert.throws(() => requireOpaqueToastFill(changed), /background|fill/);
      } else {
        for (const mode of Object.keys(modes)) {
          assert.throws(() => destructiveFillAlphas(changed, mode), /background|fill/);
        }
      }
    }
  });
}
