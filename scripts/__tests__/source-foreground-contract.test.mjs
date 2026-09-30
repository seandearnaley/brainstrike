import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { parsePalette, readUtilityColors } from '../lib/foreground-contrast.mjs';
import { FOREGROUND_SURFACE_EXCEPTIONS } from '../lib/foreground-surface-exceptions.mjs';
import { readSharedThemeCss } from '../lib/semantic-theme-contract.mjs';
import {
  auditForegroundSources,
  lightThemeSurfaces,
  NON_UI_SOURCE_FILES,
  productionSources,
} from '../lib/source-foreground-contract.mjs';

const root = join(import.meta.dirname, '..', '..');
const require = createRequire(join(root, 'packages/ui/package.json'));
const paletteCss = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
const palette = parsePalette(paletteCss);
const surfaces = lightThemeSurfaces(readSharedThemeCss(root));
const source = (text, path = 'packages/example/src/card.tsx') => ({ path, source: text });
const audit = (sources, exceptions = []) =>
  auditForegroundSources({ exceptions, palette, sources, surfaces });

it('recognizes every numbered family in the installed palette, including new Tailwind families', () => {
  assert.equal(
    palette.size,
    [...paletteCss.matchAll(/--color-[a-z]+-\d+:/g)].length,
    'Every numbered palette entry must be parsed'
  );
  for (const color of palette.keys()) {
    assert.equal(
      readUtilityColors(`text-${color}`).length,
      1,
      `Unrecognized installed palette color ${color}`
    );
  }
});
const darkPanel = source('const view = <p className="bg-black text-slate-200">Readable text</p>;');
const exception = {
  anchors: [{ count: 1, literal: 'bg-black text-slate-200' }],
  count: 1,
  literal: 'bg-black text-slate-200',
  path: darkPanel.path,
  reason: 'This standalone panel explicitly paints an opaque black background.',
  surfaces: { 'bg-black': [0, 0, 0] },
  utility: 'text-slate-200',
};

it('measures every supported light surface including high-contrast overrides', () => {
  assert.equal(Object.keys(surfaces).length, 16);
  assert.ok(Object.hasOwn(surfaces, 'high-contrast-light/accent'));
  assert.throws(() => lightThemeSurfaces(':root {}'), /Missing numeric HSL/);
});

it('fails new ordinary text, state variants, reduced alpha and semantic warnings anywhere', () => {
  const errors = audit([
    source(
      'const classes = "text-green-500 hover:text-sky-600 text-slate-900/30 dark:text-amber-300 bg-amber-500/15 border-yellow-200";'
    ),
  ]);
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /text-green-500.*4.5/);
  assert.match(errors.join('\n'), /dark:text-amber-300.*text-warning/);
  assert.match(errors.join('\n'), /card.tsx:1/);
});

it('passes sufficient contrast, dark-only non-warning foregrounds and pale background tints', () => {
  assert.deepEqual(
    audit([
      source(
        'const classes = "text-slate-900 dark:text-sky-300 text-warning bg-amber-500/15 border-yellow-200";'
      ),
    ]),
    []
  );
});

it('requires measured exceptions tied to exact source occurrences and live backdrops', () => {
  assert.equal(audit([darkPanel]).length, 1);
  assert.deepEqual(audit([darkPanel], [exception]), []);
  assert.match(audit([], [exception]).join('\n'), /stale.*expected 1.*found 0/);
  assert.match(
    audit(
      [source(`${darkPanel.source}\nconst duplicate = "bg-black text-slate-200";`)],
      [exception]
    ).join('\n'),
    /expected 1.*found 2/
  );
  assert.match(audit([darkPanel], [{ ...exception, reason: '' }]).join('\n'), /reason/);
  assert.match(audit([darkPanel], [exception, exception]).join('\n'), /duplicate/);
  assert.match(
    audit([darkPanel], [{ ...exception, anchors: [{ count: 1, literal: 'bg-slate-950' }] }]).join(
      '\n'
    ),
    /backdrop anchor/
  );
});

it('requires the measured backdrop on the foreground element or its JSX ancestors', () => {
  const foreground = '<span className="text-slate-200">Text</span>';
  const anchored = {
    ...exception,
    anchors: [{ count: 1, literal: 'bg-black' }],
    literal: 'text-slate-200',
  };
  assert.deepEqual(
    audit([source(`<div className="bg-black"><><div>${foreground}</div></></div>`)], [anchored]),
    []
  );
  for (const text of [
    `<><div className="bg-black" />${foreground}</>`,
    `const unused = "bg-black"; const view = ${foreground};`,
    '<div className="bg-black" title="text-slate-200" />',
    '<div className="bg-black">{"text-slate-200"}</div>',
  ]) {
    assert.match(audit([source(text)], [anchored]).join('\n'), /associated JSX backdrop/);
  }
});

it('rejects intervening paints and unresolved JSX paint boundaries', () => {
  const foreground = '<span className="text-slate-200">Text</span>';
  const anchored = {
    ...exception,
    anchors: [{ count: 1, literal: 'bg-black' }],
    literal: 'text-slate-200',
  };
  for (const attributes of [
    'className="bg-white"',
    'className="hover:bg-white"',
    'className="dark:!bg-white"',
    'className="bg-white!"',
    'className="[background:white]"',
    'className={classes}',
    'className={cn("p-1", classes)}',
    'style={{ background: "white" }}',
    '{...props}',
  ]) {
    assert.match(
      audit(
        [source(`<div className="bg-black"><div ${attributes}>${foreground}</div></div>`)],
        [anchored]
      ).join('\n'),
      /associated JSX backdrop/,
      attributes
    );
  }
  assert.match(
    audit(
      [source(`<div className="bg-black"><Panel>${foreground}</Panel></div>`)],
      [anchored]
    ).join('\n'),
    /associated JSX backdrop/
  );
  assert.match(
    audit(
      [
        source(
          '<div className="bg-black" style={{ background: "white" }}><span className="text-slate-200" /></div>'
        ),
      ],
      [anchored]
    ).join('\n'),
    /associated JSX backdrop/
  );
});

it('fails a moved real bootstrap label even when all exact literal and anchor counts survive', () => {
  const path = 'apps/desktop/src/renderer/main.tsx';
  const original = readFileSync(join(root, path), 'utf8');
  const label = '<p className="mt-3 text-slate-200 text-sm">{validation.message}</p>';
  assert.ok(original.includes(label));
  const moved = original
    .replace(label, '')
    .replace('      </div>\n    </div>', `      </div>\n      ${label}\n    </div>`);
  const entries = FOREGROUND_SURFACE_EXCEPTIONS.filter((entry) => entry.path === path);
  assert.deepEqual(audit([source(original, path)], entries), []);
  const errors = audit([source(moved, path)], entries);
  assert.match(errors.join('\n'), /associated JSX backdrop/);
  assert.ok(
    errors.every((error) => !/expected|stale/.test(error)),
    errors.join('\n')
  );
});

it('does not waive contrast or warning semantics just because an exception exists', () => {
  assert.match(
    audit([darkPanel], [{ ...exception, surfaces: { white: [1, 1, 1] } }]).join('\n'),
    /4.5/
  );
  assert.match(audit([darkPanel], [{ ...exception, surfaces: {} }]).join('\n'), /surface/);
  const warning = source('const classes = "bg-black text-amber-300";');
  assert.match(
    audit(
      [warning],
      [
        {
          ...exception,
          anchors: [{ count: 1, literal: 'bg-black text-amber-300' }],
          literal: 'bg-black text-amber-300',
          utility: 'text-amber-300',
        },
      ]
    ).join('\n'),
    /text-warning/
  );
});

it('allows only precisely documented aria-hidden decorations, never a status glyph by inference', () => {
  const decoration = source('<Sparkles aria-hidden="true" className="text-sky-500" />');
  const decorativeException = {
    count: 1,
    decorative: true,
    element: 'Sparkles',
    literal: 'text-sky-500',
    path: decoration.path,
    reason: 'Redundant ornament beside a complete text label.',
    utility: 'text-sky-500',
  };
  assert.equal(audit([decoration]).length, 1);
  assert.deepEqual(audit([decoration], [decorativeException]), []);
  assert.match(
    audit(
      [source(decoration.source.replace('aria-hidden="true"', 'aria-label="Status"'))],
      [decorativeException]
    ).join('\n'),
    /aria-hidden/
  );
  assert.match(
    audit(
      [source(decoration.source.replace('aria-hidden="true"', 'aria-hidden={false}'))],
      [decorativeException]
    ).join('\n'),
    /aria-hidden/
  );
  assert.match(
    audit([source(decoration.source.replace('Sparkles', 'Check'))], [decorativeException]).join(
      '\n'
    ),
    /aria-hidden Sparkles/
  );
});

const sources = productionSources(root);
it('includes new production files without enumerating them and omits non-production fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'foreground-contract-'));
  try {
    const paths = [
      'apps/new-app/src/new.tsx',
      'packages/new-package/src/nested/new.ts',
      'packages/new-package/src/new.jsx',
      'packages/new-package/src/test/card.tsx',
      'packages/new-package/src/tests/card.tsx',
      'packages/new-package/src/new.test.tsx',
      'packages/new-package/src/__fixtures__/sample.ts',
      'packages/new-package/src/__tests__/sample.tsx',
      'packages/new-package/src/__mocks__/sample.tsx',
      'packages/new-package/src/test/card.spec.tsx',
      'packages/new-package/src/tests/card.stories.tsx',
    ];
    for (const path of paths) {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), 'const classes = "text-red-500";');
    }
    assert.deepEqual(
      productionSources(directory).map(({ path }) => path),
      paths.slice(0, 5).sort((left, right) => left.localeCompare(right))
    );
    const errors = audit(productionSources(directory));
    assert.equal(errors.length, 5);
    assert.ok(errors.some((error) => error.includes('/src/test/card.tsx:')));
    assert.ok(errors.some((error) => error.includes('/src/tests/card.tsx:')));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('walks production source across both apps and shared packages without vacuous coverage', () => {
  assert.ok(
    sources.length >= 1000,
    `Expected at least 1000 production source files, got ${sources.length}`
  );
  assert.ok(sources.some(({ path }) => path.startsWith('apps/web/src/')));
  for (const path of ['apps/desktop/src/renderer/main.tsx', 'packages/ui/src/toast.tsx']) {
    assert.ok(
      sources.some((entry) => entry.path === path),
      `Missing ${path}`
    );
  }
  assert.ok(sources.every(({ path }) => !/\.(test|spec|stories)\.|\/__tests__\//.test(path)));
  for (const path of NON_UI_SOURCE_FILES) {
    assert.ok(existsSync(join(root, path)), `Stale non-UI code-sample exclusion: ${path}`);
    assert.ok(!sources.some((entry) => entry.path === path));
  }
});

it('production palette foregrounds meet AA or their precise measured surface contract', () => {
  assert.deepEqual(audit(sources, FOREGROUND_SURFACE_EXCEPTIONS), []);
});
