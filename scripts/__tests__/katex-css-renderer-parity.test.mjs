import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS_IMPORTER = 'packages/ui';

// KaTeX is a two-part package: `katex/dist/katex.min.css` (imported by
// packages/ui/src/markdown-surface/markdown-surface.tsx) and the renderer that
// emits the markup those selectors target. Nothing in this repo imports katex's
// JavaScript — the markup comes from rehype-katex, which depends on its own
// katex copy. Two independently resolved katex versions therefore mean the
// stylesheet and the markup can come from different releases, which is exactly
// what BST-1276 found (CSS 0.17.0 vs renderer 0.16.47). KaTeX 0.18.0 renames
// ~20 internal classes to a `katex-` prefix (KaTeX/KaTeX#4229, BREAKING), so
// the skew stops being cosmetic the moment either side crosses that boundary.
const RENDERER_PACKAGE = 'rehype-katex';

function parseVersion(version) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version ?? '');
  return match?.groups
    ? {
        major: Number(match.groups.major),
        minor: Number(match.groups.minor),
        patch: Number(match.groups.patch),
      }
    : null;
}

function collectViolations({ cssVersion, rendererVersion, resolvedVersions }) {
  const violations = [];
  const css = parseVersion(cssVersion);
  const renderer = parseVersion(rendererVersion);

  if (!css) {
    violations.push(`could not resolve a katex version for the ${CSS_IMPORTER} stylesheet import`);
  }
  if (!renderer) {
    violations.push(`could not resolve the katex version ${RENDERER_PACKAGE} renders with`);
  }
  if (css && renderer && (css.major !== renderer.major || css.minor !== renderer.minor)) {
    violations.push(
      `katex CSS/renderer skew: ${CSS_IMPORTER} loads the stylesheet from katex@${cssVersion} but ${RENDERER_PACKAGE} emits markup from katex@${rendererVersion}. Align the direct katex range with whatever ${RENDERER_PACKAGE} resolves.`
    );
  }
  if (resolvedVersions.length !== 1) {
    violations.push(
      `expected exactly one katex version in the lockfile, found ${resolvedVersions.length}: ${resolvedVersions.join(', ')}`
    );
  }
  return violations;
}

function loadActualState() {
  const lockfile = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const rendererEntry = Object.entries(lockfile.snapshots ?? {}).find(([id]) =>
    id.startsWith(`${RENDERER_PACKAGE}@`)
  );
  const resolvedVersions = Object.keys(lockfile.packages ?? {})
    .filter((id) => id.startsWith('katex@'))
    .map((id) => id.slice('katex@'.length))
    .sort();
  return {
    cssVersion: lockfile.importers?.[CSS_IMPORTER]?.dependencies?.katex?.version,
    rendererVersion: rendererEntry?.[1]?.dependencies?.katex,
    resolvedVersions,
  };
}

test('real tree: the katex stylesheet and the katex renderer come from one release', () => {
  const state = loadActualState();
  assert.deepEqual(collectViolations(state), []);
});

test('real tree: rehype-katex is the only producer of KaTeX markup', () => {
  // The pin argument only holds while katex's JS is unused. If a direct
  // `import katex from 'katex'` ever lands, this contract needs rewriting
  // around that call site instead of around rehype-katex's resolution.
  const uiManifest = JSON.parse(
    readFileSync(path.join(repoRoot, CSS_IMPORTER, 'package.json'), 'utf8')
  );
  assert.ok(
    uiManifest.dependencies?.[RENDERER_PACKAGE],
    `${CSS_IMPORTER} must depend on ${RENDERER_PACKAGE} for this contract to mean anything`
  );
});

test('money control: the pre-BST-1276 skew fails visibly', () => {
  const violations = collectViolations({
    cssVersion: '0.17.0',
    rendererVersion: '0.16.47',
    resolvedVersions: ['0.16.47', '0.17.0'],
  });
  assert.match(violations.join('\n'), /katex CSS\/renderer skew/u);
  assert.match(violations.join('\n'), /expected exactly one katex version/u);
});

test('money control: a blanket bump of the CSS dep to the class-renaming major fails visibly', () => {
  const violations = collectViolations({
    cssVersion: '0.18.0',
    rendererVersion: '0.16.47',
    resolvedVersions: ['0.16.47', '0.18.0'],
  });
  assert.match(violations.join('\n'), /katex CSS\/renderer skew/u);
});

test('money control: a matched pair passes', () => {
  assert.deepEqual(
    collectViolations({
      cssVersion: '0.16.47',
      rendererVersion: '0.16.47',
      resolvedVersions: ['0.16.47'],
    }),
    []
  );
});
