import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePnpmLockfile } from '../pnpm-lockfile.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// vite-plugin-top-level-await builds SWC AST nodes in JS and hands them back to
// SWC to print. swc 1.16.0 changed the Rust-side AST representation, so
// Compiler.printSync now rejects those nodes with:
//
//   [plugin vite-plugin-top-level-await] Error: missing field `type`
//       at Compiler.printSync (swc/core/index.js:257:29)
//
// Proven by A/B against pristine main (BST-1311). Only apps/desktop still uses
// the plugin (renderer plugins and worker.plugins in apps/desktop/vite.config.mts);
// apps/web emits native top-level await and no longer depends on it.
//
// BOTH swc packages matter. The plugin depends on each directly and chooses at
// require() time (dist/swc.js: `try { require("@swc/core") } catch {
// require("@swc/wasm") }`), so the wasm copy is live code wherever the native
// binding fails to load. Measured: with the `@swc/wasm` override removed,
// `pnpm update -r --depth Infinity @swc/wasm` resolves 1.16.0; with it, the
// tree stays on 1.15.x.
//
// This guard reads the versions the PLUGIN ITSELF resolves, not every @swc/*
// version in the lockfile. That distinction is load-bearing: `@swc/wasm` is
// also an optional peer of `ts-node`, which today shares the same resolution.
// If those ever split, ts-node landing on 1.16.x would be harmless to the
// plugin, and a whole-lockfile sweep would fail for no reason. Reading the
// plugin's own edge stays correct either way, and remains mechanism-agnostic —
// it asserts the RESULT, so it holds however the pin is expressed.
const GUARDED = ['@swc/core', '@swc/wasm'];
const FIRST_BROKEN = [1, 16, 0];
const PLUGIN = 'vite-plugin-top-level-await';

/** `'1.15.47(@swc/helpers@0.5.23)'` → `'1.15.47'`. */
export function stripPeerSuffix(version) {
  return version.replace(/\(.*\)$/su, '');
}

export function isAtLeast(version, [major, minor, patch]) {
  const parts = stripPeerSuffix(version).split('-')[0].split('.').map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) {
    return false;
  }
  const [vMajor, vMinor, vPatch] = parts;
  if (vMajor !== major) {
    return vMajor > major;
  }
  if (vMinor !== minor) {
    return vMinor > minor;
  }
  return vPatch >= patch;
}

export function collectViolations(snapshots) {
  const violations = [];
  const pluginSnapshots = Object.entries(snapshots ?? {}).filter(([id]) =>
    id.startsWith(`${PLUGIN}@`)
  );

  if (pluginSnapshots.length === 0) {
    violations.push(
      `${PLUGIN} is no longer in the lockfile, so the @swc/* pins in pnpm-workspace.yaml are inert. Delete both \`${PLUGIN}>@swc/*\` overrides, widen the \`@swc/core\` catalog entry back to a caret range, and delete this guard.`
    );
    return violations;
  }

  for (const [id, snapshot] of pluginSnapshots) {
    for (const name of GUARDED) {
      const resolved = snapshot?.dependencies?.[name];

      if (resolved === undefined) {
        violations.push(
          `${PLUGIN} no longer resolves ${name} (in ${id}). The guard has drifted from reality — re-check dist/swc.js before relaxing anything.`
        );
        continue;
      }

      if (isAtLeast(resolved, FIRST_BROKEN)) {
        violations.push(
          `${PLUGIN} resolves ${name}@${stripPeerSuffix(resolved)} (in ${id}), which breaks it with "missing field \`type\`" out of Compiler.printSync (BST-1311). Keep it below 1.16.0 — see the overrides block in pnpm-workspace.yaml. This breaks the WEB and DESKTOP builds, not just desktop.`
        );
      }
    }
  }

  return violations;
}

function loadSnapshots() {
  return parsePnpmLockfile(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')).snapshots;
}

test('real tree: the TLA plugin resolves no swc version that breaks it', () => {
  assert.deepEqual(collectViolations(loadSnapshots()), []);
});

test('money control: @swc/core walking to 1.16.0 fails visibly', () => {
  const violations = collectViolations({
    'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
      dependencies: { '@swc/core': '1.16.0(@swc/helpers@0.5.23)', '@swc/wasm': '1.15.43' },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /resolves @swc\/core@1\.16\.0 \(in /u);
  assert.match(violations[0], /missing field/u);
});

test('money control: @swc/wasm alone walking to 1.16.0 fails visibly', () => {
  // The gap this guard was added for: the first fix pinned only @swc/core, so
  // `pnpm update -r --depth Infinity` could still move the wasm fallback.
  // Measured against the real registry — 1.16.0 is published, so this was live.
  const violations = collectViolations({
    'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
      dependencies: { '@swc/core': '1.15.47(@swc/helpers@0.5.23)', '@swc/wasm': '1.16.0' },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /resolves @swc\/wasm@1\.16\.0 \(in /u);
});

test('an unrelated subtree on 1.16 does NOT trip the guard', () => {
  // ts-node carries @swc/wasm as an optional peer. Today it shares the plugin's
  // resolution; if it ever splits, its own copy is none of this guard's business.
  const violations = collectViolations({
    'ts-node@10.9.2(@swc/wasm@1.16.0)': { dependencies: { '@swc/wasm': '1.16.0' } },
    'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
      dependencies: { '@swc/core': '1.15.47(@swc/helpers@0.5.23)', '@swc/wasm': '1.15.43' },
    },
  });
  assert.deepEqual(violations, []);
});

test('money control: dropping the plugin without unpinning fails visibly', () => {
  const violations = collectViolations({ 'ts-node@10.9.2': { dependencies: {} } });
  assert.match(violations.join('\n'), /no longer in the lockfile/u);
  assert.match(violations.join('\n'), /delete this guard/u);
});

test('money control: the plugin losing an swc edge is reported, not silently skipped', () => {
  const violations = collectViolations({
    'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
      dependencies: { '@swc/core': '1.15.47(@swc/helpers@0.5.23)' },
    },
  });
  assert.match(violations.join('\n'), /no longer resolves @swc\/wasm/u);
});

test('money control: the current pinned pair passes', () => {
  assert.deepEqual(
    collectViolations({
      'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
        dependencies: { '@swc/core': '1.15.47(@swc/helpers@0.5.23)', '@swc/wasm': '1.15.43' },
      },
    }),
    []
  );
});

test('every duplicated plugin instance is checked, not just the first', () => {
  const violations = collectViolations({
    'vite-plugin-top-level-await@1.6.0(vite@8.2.1)': {
      dependencies: { '@swc/core': '1.15.47', '@swc/wasm': '1.15.43' },
    },
    'vite-plugin-top-level-await@1.6.0(vite@9.0.0)': {
      dependencies: { '@swc/core': '1.16.0', '@swc/wasm': '1.15.43' },
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /vite@9\.0\.0/u);
});

test('version comparison handles majors, prereleases, and peer suffixes', () => {
  assert.equal(isAtLeast('2.0.0', FIRST_BROKEN), true);
  assert.equal(isAtLeast('1.16.0', FIRST_BROKEN), true);
  assert.equal(isAtLeast('1.15.47', FIRST_BROKEN), false);
  assert.equal(isAtLeast('1.15.47(@swc/helpers@0.5.23)', FIRST_BROKEN), false);
  assert.equal(isAtLeast('1.16.0-nightly-20260814.1', FIRST_BROKEN), true);
  assert.equal(isAtLeast('0.5.23', FIRST_BROKEN), false);
});
