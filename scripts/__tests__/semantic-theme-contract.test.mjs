import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import {
  auditSemanticTheme,
  cssBlocks,
  extractThemeColors,
  findSemanticUtilities,
  readAppThemes,
  readSharedThemeCss,
} from '../lib/semantic-theme-contract.mjs';

const root = join(import.meta.dirname, '..', '..');
const fixture = () => ({
  appThemes: {
    desktop: '@theme { --color-status: var(--status); }',
    web: '@theme { --color-status: var(--status); }',
  },
  exceptions: [],
  sharedCss: ':root { --bs-status: hsl(120 50% 30%); --status: var(--bs-status); }',
  sources: [{ path: 'packages/ui/src/example.tsx', source: '<span className="text-status" />' }],
});

describe('semantic mapping guard negative controls', () => {
  it('accepts a complete definition → alias → @theme chain', () => {
    assert.deepEqual(auditSemanticTheme(fixture()), []);
  });
  it('catches missing aliases even when both apps declare the mapping', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-status: hsl(120 50% 30%); }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*alias/);
  });
  it('checks aliases and definitions separately in every effective theme mode', () => {
    const input = fixture();
    input.sharedCss =
      ':root { --bs-status: hsl(120 50% 30%); } .dark { --status: var(--bs-status); }';
    assert.match(auditSemanticTheme(input).join('\n'), /light.*status.*alias/);
    input.sharedCss = `${fixture().sharedCss} @media (prefers-contrast: more) { .dark { --status: var(--bs-missing); } }`;
    assert.match(auditSemanticTheme(input).join('\n'), /high-contrast-dark.*status.*alias/);
    input.sharedCss =
      ':root { --status: var(--bs-status); } .dark { --bs-status: hsl(120 50% 30%); }';
    assert.match(auditSemanticTheme(input).join('\n'), /light.*status.*definition/);
  });
  it('fails closed on semantic declarations inside unsupported nested selectors', () => {
    const input = fixture();
    input.sharedCss =
      ':root { .dark { --bs-status: hsl(120 50% 30%); --status: var(--bs-status); } }';
    assert.throws(() => auditSemanticTheme(input), /Unsupported semantic theme scope/);
    input.sharedCss = `${fixture().sharedCss} .dark { @media (prefers-contrast: more) { --bs-status: hsl(0 0% 50%); } }`;
    assert.throws(() => auditSemanticTheme(input), /Unsupported semantic theme scope/);
    input.sharedCss = `${fixture().sharedCss} @supports (color: red) { :root { --bs-status: hsl(0 0% 50%); } }`;
    assert.throws(() => auditSemanticTheme(input), /Unsupported semantic theme scope/);
    // Harmless nesting cannot overwrite a direct theme declaration either.
    input.sharedCss = `${fixture().sharedCss} :root { .child { color: red; } }`;
    assert.deepEqual(auditSemanticTheme(input), []);
  });
  it('catches a token omitted from both apps, not just app drift', () => {
    const input = fixture();
    input.appThemes = { desktop: '@theme {}', web: '@theme {}' };
    assert.match(auditSemanticTheme(input).join('\n'), /status.*mapping/);
  });
  it('catches app parity drift even before the new token has a consumer', () => {
    const input = fixture();
    input.appThemes.desktop = '@theme { --color-status: var(--status); --color-extra: red; }';
    assert.match(auditSemanticTheme(input).join('\n'), /parity/);
  });
  it('rejects a present but miswired mapping or alias', () => {
    const input = fixture();
    input.appThemes.web = '@theme { --color-status: var(--other); }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*var\(--status\)/);
    input.sharedCss = ':root { --bs-status: hsl(120 50% 30%); --status: var(--bs-other); }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*alias/);
  });
  it('rejects the legacy triplet definition and hsl(var()) mapping formats', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-status: 120 50% 30%; --status: var(--bs-status); }';
    assert.match(auditSemanticTheme(input).join('\n'), /No semantic color definitions found/);
    const legacy = fixture();
    legacy.appThemes.web = '@theme { --color-status: hsl(var(--status)); }';
    assert.match(
      auditSemanticTheme(legacy).join('\n'),
      /web status mapping must be var\(--status\)/
    );
  });
  it('requires @theme scope, ignoring comments and decoy root declarations', () => {
    assert.deepEqual(
      [
        ...extractThemeColors(
          '/* @theme { --color-fake: red; } */ :root { --color-fake: red; } @theme { --color-real: red; @keyframes spin { to { transform: none; } } }'
        ),
      ],
      [['real', 'red']]
    );
  });
  it('finds exact token names across stacked variants, arbitrary variants and opacity', () => {
    const utilities = findSemanticUtilities(
      'hover:before:focus-visible:text-status/70 [&:nth-child(2)]:ring-offset-status/50 text-status-foreground! text-statusish',
      new Set(['status', 'status-foreground'])
    );
    assert.deepEqual(
      utilities.map(({ token, utility }) => [token, utility]),
      [
        ['status', 'text'],
        ['status', 'ring-offset'],
        ['status-foreground', 'text'],
      ]
    );
    const input = fixture();
    input.sharedCss = ':root { --bs-status: hsl(120 50% 30%); }';
    input.appThemes = { desktop: '@theme {}', web: '@theme {}' };
    input.sources[0].source = 'focus-visible:hover:text-status/70';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*mapping/);
  });
  it('rejects invalid suffixes of known semantic tokens instead of dropping them', () => {
    const input = fixture();
    input.sharedCss =
      ':root { --bs-destructive: hsl(8 55% 39%); --destructive: var(--bs-destructive); --bs-destructive-foreground: hsl(0 0% 100%); --destructive-foreground: var(--bs-destructive-foreground); }';
    const theme =
      '@theme { --color-destructive: var(--destructive); --color-destructive-foreground: var(--destructive-foreground); }';
    input.appThemes = { desktop: theme, web: theme };
    for (const candidate of [
      'text-destructive-foreground-foreground',
      'hover:group-[.destructive]:text-destructive-foreground-foreground/70',
      'focus-visible:border-b-destructive-foreground-extra!',
    ]) {
      input.sources[0].source = `<div className="${candidate}" />`;
      const errors = auditSemanticTheme(input).join('\n');
      assert.match(errors, /packages\/ui\/src\/example\.tsx/);
      assert.match(errors, /unknown semantic token destructive-foreground-(?:foreground|extra)/);
    }
    input.sources[0].source = 'text-destructive-foreground hover:text-destructive/70';
    assert.deepEqual(auditSemanticTheme(input), []);
    input.sources[0].source = 'text-destructiveish text-slate-500 text-unknown-semantic';
    assert.deepEqual(auditSemanticTheme(input), []);
  });
  it('catches every supported color utility prefix', () => {
    const prefixes = [
      'text',
      'bg',
      'border',
      'border-x',
      'border-y',
      'border-t',
      'border-r',
      'border-b',
      'border-l',
      'border-s',
      'border-e',
      'divide-x',
      'divide-y',
      'ring',
      'ring-offset',
      'fill',
      'stroke',
      'outline',
      'divide',
      'from',
      'via',
      'to',
      'caret',
      'placeholder',
      'accent',
      'decoration',
      'shadow',
    ];
    assert.equal(
      findSemanticUtilities(
        prefixes.map((prefix) => `${prefix}-status`).join(' '),
        new Set(['status'])
      ).length,
      prefixes.length
    );
  });
  it('lets chart arbitrary values bypass mapping but never direct utilities', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-chart-1: hsl(120 50% 30%); --chart-1: var(--bs-chart-1); }';
    input.appThemes = { desktop: '@theme {}', web: '@theme {}' };
    input.exceptions = [
      { kind: 'arbitrary', reason: 'Chart color used through var().', token: 'chart-1' },
    ];
    input.sources[0].source = 'text-[var(--chart-1)]';
    assert.deepEqual(auditSemanticTheme(input), []);
    input.sources[0].source = 'hover:text-chart-1/70';
    assert.match(auditSemanticTheme(input).join('\n'), /chart-1.*mapping/);
  });
  it('limits handwritten bypasses to their real utility and validates the rule', () => {
    const input = fixture();
    input.sharedCss =
      ':root { --bs-panel: linear-gradient(red, blue); --panel: var(--bs-panel); } .bg-panel { background-image: var(--panel); }';
    input.appThemes = { desktop: '@theme {}', web: '@theme {}' };
    input.exceptions = [
      { kind: 'handwritten', reason: 'Gradient component rule.', token: 'panel', utility: 'bg' },
    ];
    input.sources[0].source = 'bg-panel';
    assert.deepEqual(auditSemanticTheme(input), []);
    input.sources[0].source = 'text-panel';
    assert.match(auditSemanticTheme(input).join('\n'), /panel.*mapping/);
    input.sources[0].source = 'hover:bg-panel';
    assert.match(auditSemanticTheme(input).join('\n'), /panel.*mapping/);
    input.sources[0].source = 'hover:!bg-panel';
    assert.match(auditSemanticTheme(input).join('\n'), /panel.*mapping/);
    input.sources[0].source = 'bg-panel/70';
    assert.match(auditSemanticTheme(input).join('\n'), /panel.*mapping/);
    input.sharedCss = input.sharedCss.replace('.bg-panel { background-image: var(--panel); }', '');
    assert.match(auditSemanticTheme(input).join('\n'), /handwritten.*rule/);
  });
  it('fails stale, duplicate and unexplained exceptions', () => {
    const input = fixture();
    input.exceptions = [{ kind: 'arbitrary', reason: 'Former divergence.', token: 'status' }];
    assert.match(auditSemanticTheme(input).join('\n'), /stale.*status/);
    input.exceptions.push(input.exceptions[0]);
    assert.match(auditSemanticTheme(input).join('\n'), /duplicate/);
    input.exceptions = [{ kind: 'arbitrary', reason: '', token: 'ghost' }];
    assert.match(auditSemanticTheme(input).join('\n'), /reason|stale/);
  });
});

function sourceFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '__tests__', '__mocks__'].includes(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) {
      return [];
    }
    return [{ path: relative(root, path), source: readFileSync(path, 'utf8') }];
  });
}

it('keeps live shared semantic utilities connected to both app @theme blocks', () => {
  const sources = ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => sourceFiles(join(root, group, entry.name, 'src')))
  );
  assert.ok(sources.length >= 100, `Source scan must not pass vacuously (${sources.length} files)`);
  const result = auditSemanticTheme({
    appThemes: readAppThemes(root),
    sharedCss: readSharedThemeCss(root),
    sources,
  });
  assert.deepEqual(result, [], result.join('\n'));
});

it('compiles semantic utilities, variants and opacity through each real app theme', async () => {
  const candidates = ['success', 'info', 'warning', 'destructive'].flatMap((token) => [
    `text-${token}`,
    `bg-${token}`,
    `fill-${token}`,
    `text-${token}-foreground`,
    `hover:text-${token}/70`,
    `dark:before:text-${token}/70`,
  ]);
  const appThemes = readAppThemes(root);
  for (const app of ['web', 'desktop']) {
    const appRequire = createRequire(join(root, 'apps', app, 'package.json'));
    const { compile } = appRequire('tailwindcss');
    const entrypoint =
      app === 'web' ? 'apps/web/src/app/globals.css' : 'apps/desktop/src/renderer/styles.css';
    const source = appThemes[app];
    const theme = cssBlocks(source)
      .filter(({ header }) => /^@theme(?:\s|$)/.test(header))
      .map(({ header, body }) => `${header} {${body}}`)
      .join('\n');
    const darkVariant = source.match(/@custom-variant dark[^;]+;/)?.[0];
    assert.ok(darkVariant, `${entrypoint} must declare its dark variant`);
    const compiler = await compile(`${theme}\n${darkVariant}\n@tailwind utilities;`);
    const output = compiler.build(candidates);
    for (const candidate of candidates) {
      const selector = `.${candidate.replace(/[:/]/g, '\\$&')}`;
      assert.ok(output.includes(selector), `${entrypoint} emitted no rule for ${candidate}`);
    }
    // Prove the compiler catches the silent-no-CSS defect independently of the
    // static parser: source text alone cannot materialize an unmapped utility.
    const brokenTheme = theme.replace(/--color-success:\s*[^;]+;/, '');
    const broken = await compile(`${brokenTheme}\n@tailwind utilities;`);
    const missingRules = broken.build(['text-success', 'fill-success']);
    assert.ok(!missingRules.includes('.text-success {'));
    assert.ok(!missingRules.includes('.fill-success {'));
  }
});
