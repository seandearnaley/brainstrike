import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

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

// Scope is deliberately the CSS importer + the renderer, NOT the whole lockfile.
// Guard renderers used by the shared surface: rehype-katex and Mermaid. A
// separate CLI consumer is outside this CSS contract; the security guard still
// checks every KaTeX copy. Mermaid's embedded renderer gets its own behavior test.
const GUARDED_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SCANNED_ROOTS = ['apps', 'packages'];

// Matches katex's JS entry only. `katex/dist/katex.min.css` has a longer
// specifier and `rehype-katex` has a longer package name, so the quote
// immediately after `katex` excludes both.
const KATEX_JS_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]katex['"]/u;

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

function collectViolations({ cssVersion, rendererVersions }) {
  const violations = [];
  const css = parseVersion(cssVersion);

  if (!css) {
    violations.push(`could not resolve a katex version for the ${CSS_IMPORTER} stylesheet import`);
  }
  if (rendererVersions.length === 0) {
    violations.push(`could not resolve the katex version ${RENDERER_PACKAGE} renders with`);
  }

  // Compare EVERY rehype-katex snapshot, not just the first. Two snapshots can
  // coexist mid-migration, and a skew in the second one is still a skew.
  for (const { id, version } of rendererVersions) {
    const renderer = parseVersion(version);
    if (!renderer) {
      violations.push(`could not parse the katex version ${id} renders with (got ${version})`);
      continue;
    }
    if (css && (css.major !== renderer.major || css.minor !== renderer.minor)) {
      violations.push(
        `katex CSS/renderer skew: ${CSS_IMPORTER} loads the stylesheet from katex@${cssVersion} but ${id} emits markup from katex@${version}. Upgrade the stylesheet and surface renderers together.`
      );
    }
  }

  // Defense in depth, scoped to the pair this contract protects: the stylesheet
  // and every renderer must land on ONE install, not merely a matching minor.
  const scoped = new Set([cssVersion, ...rendererVersions.map((entry) => entry.version)]);
  scoped.delete(undefined);
  if (scoped.size > 1) {
    violations.push(
      `expected the ${CSS_IMPORTER} stylesheet and ${RENDERER_PACKAGE} to resolve one katex install, found ${scoped.size}: ${[...scoped].sort().join(', ')}`
    );
  }
  return violations;
}

function loadActualState() {
  const lockfile = parsePnpmLockfile(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const rendererVersions = Object.entries(lockfile.snapshots ?? {})
    .filter(([id]) => id.startsWith(`${RENDERER_PACKAGE}@`))
    .map(([id, snapshot]) => ({ id, version: snapshot?.dependencies?.katex }));
  const mermaidVersion = lockfile.importers?.[CSS_IMPORTER]?.dependencies?.mermaid?.version;
  const mermaid = lockfile.snapshots[`mermaid@${mermaidVersion}`];
  assert.ok(mermaid, 'expected the UI Mermaid snapshot');
  rendererVersions.push({ id: `mermaid@${mermaidVersion}`, version: mermaid.dependencies?.katex });
  return {
    cssVersion: lockfile.importers?.[CSS_IMPORTER]?.dependencies?.katex?.version,
    rendererVersions,
  };
}

function trackedSourceFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...SCANNED_ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  return result.stdout
    .split('\0')
    .filter((file) => file && GUARDED_EXTENSIONS.has(path.extname(file)));
}

test('real tree: the katex stylesheet and the katex renderer come from one release', () => {
  const state = loadActualState();
  assert.deepEqual(collectViolations(state), []);
});

test("real tree: nothing imports katex's JavaScript", () => {
  // This is the load-bearing premise of the whole contract. Pinning the CSS
  // range to whatever rehype-katex resolves is only sound while katex's JS is
  // unused — a direct `import katex from 'katex'` would resolve against
  // packages/ui's own range and reintroduce exactly the split BST-1276 closed.
  // Asserting that packages/ui merely DEPENDS on rehype-katex proves nothing;
  // that stays true in the broken world too. So scan the source instead.
  const offenders = trackedSourceFiles().filter((file) =>
    KATEX_JS_IMPORT.test(readFileSync(path.join(repoRoot, file), 'utf8'))
  );
  assert.deepEqual(
    offenders,
    [],
    `katex's JavaScript is imported by:\n${offenders.join('\n')}\nThis contract pins the katex CSS range to ${RENDERER_PACKAGE}'s resolution, which is only valid while the JS entry is unused. Rewrite the contract around the new call site.`
  );
});

test('money control: the scan catches a direct katex JS import', () => {
  for (const specimen of [
    "import katex from 'katex';",
    'import katex from "katex";',
    "const katex = require('katex');",
    "const { render } = await import('katex');",
  ]) {
    assert.ok(KATEX_JS_IMPORT.test(specimen), `expected the scan to flag: ${specimen}`);
  }
});

test('money control: the scan ignores the CSS subpath and rehype-katex', () => {
  for (const specimen of [
    "import 'katex/dist/katex.min.css';",
    "import rehypeKatex from 'rehype-katex';",
    "import remarkMath from 'remark-math';",
  ]) {
    assert.ok(!KATEX_JS_IMPORT.test(specimen), `expected the scan to ignore: ${specimen}`);
  }
});

test('money control: the pre-BST-1276 skew fails visibly', () => {
  const violations = collectViolations({
    cssVersion: '0.17.0',
    rendererVersions: [{ id: 'rehype-katex@7.0.1', version: '0.16.47' }],
  });
  assert.match(violations.join('\n'), /katex CSS\/renderer skew/u);
  assert.match(violations.join('\n'), /resolve one katex install/u);
});

test('money control: a blanket bump of the CSS dep to the class-renaming major fails visibly', () => {
  const violations = collectViolations({
    cssVersion: '0.18.0',
    rendererVersions: [{ id: 'rehype-katex@7.0.1', version: '0.16.47' }],
  });
  assert.match(violations.join('\n'), /katex CSS\/renderer skew/u);
});

test('money control: a skew in a SECOND rehype-katex snapshot still fails', () => {
  const violations = collectViolations({
    cssVersion: '0.16.47',
    rendererVersions: [
      { id: 'rehype-katex@7.0.1', version: '0.16.47' },
      { id: 'rehype-katex@8.0.0', version: '0.18.0' },
    ],
  });
  assert.match(violations.join('\n'), /rehype-katex@8\.0\.0 emits markup from katex@0\.18\.0/u);
});

test('money control: an unrelated katex consumer does NOT fail the lane', () => {
  // The Mermaid CLI owns a separate stylesheet. Its version is checked by the
  // full-graph security guard, rather than this shared-surface parity contract.
  assert.deepEqual(
    collectViolations({
      cssVersion: '0.16.47',
      rendererVersions: [{ id: 'rehype-katex@7.0.1', version: '0.16.47' }],
    }),
    []
  );
});

test('money control: a matched pair passes', () => {
  assert.deepEqual(
    collectViolations({
      cssVersion: '0.16.47',
      rendererVersions: [{ id: 'rehype-katex@7.0.1', version: '0.16.47' }],
    }),
    []
  );
});

test('money control: diagram math cannot drift from markdown math and its CSS', () => {
  assert.match(
    collectViolations({
      cssVersion: '0.18.11',
      rendererVersions: [
        { id: 'rehype-katex@7.0.1', version: '0.18.11' },
        { id: 'mermaid@12.2.0', version: '0.16.47' },
      ],
    }).join('\n'),
    /katex CSS\/renderer skew/
  );
});
