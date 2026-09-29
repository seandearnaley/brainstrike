import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

/**
 * `packages/db` cannot import the desktop resolver, so the snapshot manifest states its own rule for
 * `profile`. This test runs the resolver's real `toProfileSegment` (extracted from its source) over a
 * corpus and requires the manifest's rule to accept everything it can produce, so a snapshot of any
 * desktop profile is never listed as invalid. The reserved-device-name half is
 * `windows-reserved-device-name-twin.test.mjs`.
 */
const desktopSource = read('apps/desktop/src/database-location.ts');
const manifestSource = read('packages/db/src/database-snapshot-manifest.ts');

function extract(source, pattern, what) {
  const match = pattern.exec(source);
  assert.ok(match, `could not find ${what}`);
  return match;
}

const desktopMaxLength = Number(
  extract(desktopSource, /const PROFILE_SEGMENT_MAX_LENGTH = (\d+);/u, 'desktop max length')[1]
);
const [, patternSource, patternFlags] = extract(
  manifestSource,
  /const PROFILE_PATTERN = \/(.+)\/([a-z]*);/u,
  'the manifest profile pattern'
);
const manifestMaxLength = Number(
  extract(manifestSource, /const PATH_SEGMENT_MAX_LENGTH = (\d+);/u, 'manifest max length')[1]
);
const profilePattern = new RegExp(patternSource, patternFlags);

// The resolver's own function, with its TypeScript annotations removed.
const [, toProfileSegmentBody] = extract(
  desktopSource,
  /function toProfileSegment\(raw: string\): string \{([\s\S]*?)\n\}/u,
  'toProfileSegment'
);
const toProfileSegment = new Function('raw', 'PROFILE_SEGMENT_MAX_LENGTH', toProfileSegmentBody);
const produce = (raw) => toProfileSegment(raw, desktopMaxLength);

/** A small deterministic generator, so a failure names the same input every run. */
function corpus() {
  const alphabet = 'abcXYZ019 ._-/\\é🙂';
  let seed = 1_234_567;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  const generated = Array.from({ length: 2000 }, () =>
    Array.from({ length: next() % 90 }, () => alphabet[next() % alphabet.length]).join('')
  );
  return [
    '_x',
    '__',
    'X.partial',
    ' Feature/X y ',
    '.hidden',
    '-lead',
    `${'a'.repeat(63)}.b`,
    'a'.repeat(200),
    ...generated,
  ];
}

test('the manifest and the desktop resolver agree on the profile length limit', () => {
  assert.equal(manifestMaxLength, desktopMaxLength);
});

test('every profile the desktop resolver can produce is a valid manifest profile', () => {
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  for (const raw of corpus()) {
    const profile = produce(raw);
    if (profile === '' || reserved.test(profile)) {
      continue; // the resolver refuses these for an override, and the manifest refuses them too
    }
    assert.ok(profilePattern.test(profile), `${JSON.stringify(raw)} -> ${JSON.stringify(profile)}`);
    assert.ok(profile.length <= manifestMaxLength, `${JSON.stringify(profile)} is too long`);
    assert.ok(!profile.endsWith('.'), `${JSON.stringify(profile)} ends in a dot`);
  }
});

test('the manifest profile pattern still rejects what the resolver never produces', () => {
  for (const bad of ['.x', '-x', 'X', 'a b', 'a/b', '']) {
    assert.ok(!profilePattern.test(bad), JSON.stringify(bad));
  }
});
