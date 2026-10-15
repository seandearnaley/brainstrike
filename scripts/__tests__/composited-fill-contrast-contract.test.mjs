// Guard for non-text fills that paint through `opacity-*` (WCAG 1.4.11, 3:1).
//
// `source-foreground-contract` measures a colour utility in isolation, which is
// correct for text and blind to compositing. #3639 moved the context-map kind
// colours to clear AA as foregrounds and claimed every fill cleared the 3:1
// non-text floor; that claim was measured on the SOLID `bg-current` swatch only.
// The gone state swaps in `GONE_FILL_CLASS`, whose `opacity-70` lets 30% of the
// muted track through, and two colours landed at 2.96:1 and 2.98:1 under
// `prefers-contrast: more` + dark. The lane stayed green because no check
// composited anything.
//
// Every input here is read from the real tree — the kind classes, the opacity,
// the track token, the palette and each mode's token values — so a change to
// any of them re-derives the numbers instead of measuring a stale assumption.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  auditCompositedFills,
  NON_TEXT_MINIMUM,
  readOpacity,
  resolveUtility,
  utilityForMode,
} from '../lib/composited-fill-contrast.mjs';
import { parsePalette } from '../lib/foreground-contrast.mjs';
import { themeModes } from '../lib/semantic-theme-contract.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const readRepoFile = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

const KINDS_FILE = 'packages/app-shell/src/context-map/context-map-kinds.ts';
const STRIP_FILE = 'packages/app-shell/src/context-map/chunk-strip.tsx';
const TRACK_TOKEN = '--bs-muted';

const require = createRequire(path.join(repoRoot, 'packages/ui/package.json'));
const palette = parsePalette(readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'));
const modes = themeModes(readRepoFile('packages/ui/src/globals.css'));

/** The `name: 'classes'` entries of an exported const object literal. */
function readClassMap(source, identifier) {
  const block = source.match(new RegExp(`${identifier}[^=]*=\\s*\\{([^}]*)\\}`, 'u'));
  assert.ok(block, `${identifier} is not an object literal`);
  const entries = [...block[1].matchAll(/(\w+):\s*'([^']+)'/gu)].map(([, key, value]) => [
    key,
    value,
  ]);
  assert.ok(entries.length > 0, `${identifier} has no string entries`);
  return Object.fromEntries(entries);
}

const kindsSource = readRepoFile(KINDS_FILE);
const stripSource = readRepoFile(STRIP_FILE);
const fills = readClassMap(kindsSource, 'KIND_COLOR_CLASS');
const goneClasses = kindsSource.match(/GONE_FILL_CLASS\s*=\s*\n?\s*'([^']+)'/u)?.[1];

test('the gone fill still paints currentColor through one opacity over the muted track', () => {
  // Identity checks: if any of these move, the measurement below is measuring
  // the wrong thing and must be re-derived rather than trusted.
  assert.ok(goneClasses, 'GONE_FILL_CLASS is not a single-quoted literal');
  assert.match(goneClasses, /currentColor/u, 'the hatch takes its colour from the text utility');
  assert.match(goneClasses, /opacity-\d+/u, 'the hatch composites through an opacity utility');
  // The track the fill composites over, and the two states it renders in.
  assert.match(stripSource, /bg-muted/u, 'the strip cell track is bg-muted');
  assert.match(
    stripSource,
    /cell\.gone \? GONE_FILL_CLASS : 'bg-current'/u,
    'the cell renders exactly the gone hatch or the solid fill'
  );
  assert.match(stripSource, /KIND_COLOR_CLASS\[cell\.kind\]/u, 'the cell colour is a kind colour');
  // The solid state is also what the legend and lens swatches paint.
  for (const file of [
    'packages/app-shell/src/context-map/thread-context-page.tsx',
    'packages/app-shell/src/context-map/context-lens.tsx',
  ]) {
    assert.match(readRepoFile(file), /bg-current/u, `${file} paints the solid fill`);
  }
});

test('every context-map fill clears the non-text floor solid AND composited', () => {
  const { measurements, violations } = auditCompositedFills({
    fills,
    modes,
    opacity: readOpacity(goneClasses),
    palette,
    trackToken: TRACK_TOKEN,
  });
  assert.deepEqual(violations, []);
  // Not vacuous: every kind, every mode, both states.
  assert.equal(Object.keys(fills).length, 5);
  assert.equal(Object.keys(modes).length, 4);
  assert.equal(measurements.length, 5 * 4 * 2);
  assert.ok(
    measurements.some(({ state }) => state === 'composited'),
    'the composited state was measured'
  );
  // Both resolution paths exercised, so neither can rot unnoticed: the numbered
  // palette and the semantic token (which carries its own high-contrast value).
  for (const source of ['palette', 'token']) {
    assert.ok(
      measurements.some((measurement) => measurement.source === source),
      `a ${source} colour was measured`
    );
  }
  // High-contrast dark is the tightest mode; prove it was actually included.
  assert.ok(
    measurements.some(({ mode, state }) => mode === 'high-contrast-dark' && state === 'composited'),
    'high-contrast dark was composited'
  );
});

test('the audit fires on the exact colours that regressed, and only when composited', () => {
  const regressed = { pinned: 'text-pink-800 dark:text-pink-400' };
  const composited = auditCompositedFills({
    fills: regressed,
    modes,
    opacity: 0.7,
    palette,
    trackToken: TRACK_TOKEN,
  });
  // 2.96:1 on high-contrast dark, and 3.12:1 on ordinary dark clears the floor,
  // so exactly one state in one mode fails.
  assert.equal(composited.violations.length, 1);
  assert.match(composited.violations[0], /high-contrast-dark/u);
  assert.match(composited.violations[0], /composited: 2\.96:1/u);
  // The same colour is fine as a solid fill, which is why measuring the utility
  // alone missed it: at full opacity nothing fails.
  const solid = auditCompositedFills({
    fills: regressed,
    modes,
    opacity: 1,
    palette,
    trackToken: TRACK_TOKEN,
  });
  assert.deepEqual(solid.violations, []);
});

test('a missing or ambiguous opacity is an error, never an assumed solid fill', () => {
  assert.throws(() => readOpacity('bg-current text-pink-300'), /Expected exactly one opacity/u);
  assert.throws(() => readOpacity('opacity-70 opacity-50'), /Expected exactly one opacity/u);
  assert.throws(() => readOpacity('opacity-700'), /not a percentage/u);
  assert.equal(readOpacity('bg-[x] opacity-70'), 0.7);
  assert.equal(readOpacity('opacity-100'), 1);
});

test('mode resolution prefers the dark variant and refuses an unknown utility', () => {
  const classes = 'text-pink-800 dark:text-pink-300';
  assert.equal(utilityForMode(classes, 'light'), 'text-pink-800');
  assert.equal(utilityForMode(classes, 'high-contrast-light'), 'text-pink-800');
  assert.equal(utilityForMode(classes, 'dark'), 'dark:text-pink-300');
  assert.equal(utilityForMode(classes, 'high-contrast-dark'), 'dark:text-pink-300');
  // A kind with no dark variant uses its single colour in both.
  assert.equal(utilityForMode('text-warning', 'high-contrast-dark'), 'text-warning');
  assert.throws(() => utilityForMode('bg-current', 'light'), /No text-\* colour utility/u);
  assert.throws(
    () => resolveUtility('text-not-a-token', 'light', { modes, palette }),
    /Missing numeric HSL/u
  );
  assert.throws(
    () => resolveUtility('text-pink-9999', 'light', { modes, palette }),
    /Unknown palette colour/u
  );
  assert.equal(NON_TEXT_MINIMUM, 3);
});

test('the semantic warning token is measured per mode, not once', () => {
  const light = resolveUtility('text-warning', 'light', { modes, palette });
  const highContrastDark = resolveUtility('text-warning', 'high-contrast-dark', {
    modes,
    palette,
  });
  assert.equal(light.source, 'token');
  assert.notDeepEqual(
    light.rgb,
    highContrastDark.rgb,
    'the warning token differs between light and high-contrast dark'
  );
});
