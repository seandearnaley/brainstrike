import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { auditSemanticTheme, cssBlocks, extractThemeColors, findSemanticUtilities } from '../lib/semantic-theme-contract.mjs';

const root = join(import.meta.dirname, '..', '..');
const fixture = () => ({
  sharedCss: ':root { --bs-status: 120 50% 30%; --status: var(--bs-status); }',
  appThemes: { web: '@theme { --color-status: hsl(var(--status)); }', desktop: '@theme { --color-status: hsl(var(--status)); }' },
  sources: [{ path: 'packages/ui/src/example.tsx', source: '<span className="text-status" />' }],
  exceptions: [],
});

describe('semantic mapping guard negative controls', () => {
  it('accepts a complete definition → alias → @theme chain', () => {
    assert.deepEqual(auditSemanticTheme(fixture()), []);
  });
  it('catches missing aliases even when both apps declare the mapping', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-status: 120 50% 30%; }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*alias/);
  });
  it('checks aliases and definitions separately in every effective theme mode', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-status: 120 50% 30%; } .dark { --status: var(--bs-status); }';
    assert.match(auditSemanticTheme(input).join('\n'), /light.*status.*alias/);
    input.sharedCss = fixture().sharedCss + ' @media (prefers-contrast: more) { .dark { --status: var(--bs-missing); } }';
    assert.match(auditSemanticTheme(input).join('\n'), /high-contrast-dark.*status.*alias/);
    input.sharedCss = ':root { --status: var(--bs-status); } .dark { --bs-status: 120 50% 30%; }';
    assert.match(auditSemanticTheme(input).join('\n'), /light.*status.*definition/);
  });
  it('catches a token omitted from both apps, not just app drift', () => {
    const input = fixture();
    input.appThemes = { web: '@theme {}', desktop: '@theme {}' };
    assert.match(auditSemanticTheme(input).join('\n'), /status.*mapping/);
  });
  it('catches app parity drift even before the new token has a consumer', () => {
    const input = fixture();
    input.appThemes.desktop = '@theme { --color-status: hsl(var(--status)); --color-extra: red; }';
    assert.match(auditSemanticTheme(input).join('\n'), /parity/);
  });
  it('rejects a present but miswired mapping or alias', () => {
    const input = fixture();
    input.appThemes.web = '@theme { --color-status: hsl(var(--other)); }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*hsl\(var\(--status\)\)/);
    input.sharedCss = ':root { --bs-status: 120 50% 30%; --status: var(--bs-other); }';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*alias/);
  });
  it('requires @theme scope, ignoring comments and decoy root declarations', () => {
    assert.deepEqual([...extractThemeColors('/* @theme { --color-fake: red; } */ :root { --color-fake: red; } @theme { --color-real: red; @keyframes spin { to { transform: none; } } }')], [['real', 'red']]);
  });
  it('finds exact token names across stacked variants, arbitrary variants and opacity', () => {
    const utilities = findSemanticUtilities('hover:before:focus-visible:text-status/70 [&:nth-child(2)]:ring-offset-status/50 text-status-foreground! text-statusish', new Set(['status', 'status-foreground']));
    assert.deepEqual(utilities.map(({ token, utility }) => [token, utility]), [
      ['status', 'text'], ['status', 'ring-offset'], ['status-foreground', 'text'],
    ]);
    const input = fixture();
    input.sharedCss = ':root { --bs-status: 120 50% 30%; }';
    input.appThemes = { web: '@theme {}', desktop: '@theme {}' };
    input.sources[0].source = 'focus-visible:hover:text-status/70';
    assert.match(auditSemanticTheme(input).join('\n'), /status.*mapping/);
  });
  it('catches every supported color utility prefix', () => {
    const prefixes = ['text', 'bg', 'border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l', 'border-s', 'border-e', 'divide-x', 'divide-y', 'ring', 'ring-offset', 'fill', 'stroke', 'outline', 'divide', 'from', 'via', 'to', 'caret', 'placeholder', 'accent', 'decoration', 'shadow'];
    assert.equal(findSemanticUtilities(prefixes.map((prefix) => `${prefix}-status`).join(' '), new Set(['status'])).length, prefixes.length);
  });
  it('lets chart arbitrary values bypass mapping but never direct utilities', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-chart-1: 120 50% 30%; --chart-1: var(--bs-chart-1); }';
    input.appThemes = { web: '@theme {}', desktop: '@theme {}' };
    input.exceptions = [{ token: 'chart-1', kind: 'arbitrary', reason: 'Chart color used through hsl(var()).' }];
    input.sources[0].source = 'text-[hsl(var(--chart-1))]';
    assert.deepEqual(auditSemanticTheme(input), []);
    input.sources[0].source = 'hover:text-chart-1/70';
    assert.match(auditSemanticTheme(input).join('\n'), /chart-1.*mapping/);
  });
  it('limits handwritten bypasses to their real utility and validates the rule', () => {
    const input = fixture();
    input.sharedCss = ':root { --bs-panel: linear-gradient(red, blue); --panel: var(--bs-panel); } .bg-panel { background-image: var(--panel); }';
    input.appThemes = { web: '@theme {}', desktop: '@theme {}' };
    input.exceptions = [{ token: 'panel', kind: 'handwritten', utility: 'bg', reason: 'Gradient component rule.' }];
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
    input.exceptions = [{ token: 'status', kind: 'arbitrary', reason: 'Former divergence.' }];
    assert.match(auditSemanticTheme(input).join('\n'), /stale.*status/);
    input.exceptions.push(input.exceptions[0]);
    assert.match(auditSemanticTheme(input).join('\n'), /duplicate/);
    input.exceptions = [{ token: 'ghost', kind: 'arbitrary', reason: '' }];
    assert.match(auditSemanticTheme(input).join('\n'), /reason|stale/);
  });
});

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '__tests__', '__mocks__'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) return [];
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
  const sharedCss = readFileSync(join(root, 'packages/ui/src/globals.css'), 'utf8');
  const appThemes = {
    web: readFileSync(join(root, 'apps/web/src/app/globals.css'), 'utf8'),
    desktop: readFileSync(join(root, 'apps/desktop/src/renderer/styles.css'), 'utf8'),
  };
  const result = auditSemanticTheme({ sharedCss, appThemes, sources });
  assert.deepEqual(result, [], result.join('\n'));
});


it('compiles semantic utilities, variants and opacity through each real app theme', async () => {
  const candidates = ['success', 'info', 'warning', 'destructive'].flatMap((token) => [
    `text-${token}`, `bg-${token}`, `text-${token}-foreground`,
    `hover:text-${token}/70`, `dark:before:text-${token}/70`,
  ]);
  for (const app of ['web', 'desktop']) {
    const appRequire = createRequire(join(root, 'apps', app, 'package.json'));
    const { compile } = appRequire('tailwindcss');
    const entrypoint = app === 'web' ? 'apps/web/src/app/globals.css' : 'apps/desktop/src/renderer/styles.css';
    const source = readFileSync(join(root, entrypoint), 'utf8');
    const theme = cssBlocks(source).filter(({ header }) => /^@theme(?:\s|$)/.test(header))
      .map(({ header, body }) => `${header} {${body}}`).join('\n');
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
    assert.ok(!broken.build(['text-success']).includes('.text-success {'));
  }
});
