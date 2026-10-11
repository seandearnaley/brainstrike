import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `packages/db` cannot import from `apps/desktop`, so the snapshot manifest carries a twin of the
 * desktop resolver's `WINDOWS_RESERVED_DEVICE_NAME`. The twin adds only the `i` flag; the
 * alternation must stay equal, or a profile the desktop accepts could be refused by the manifest
 * (or the reverse).
 */
const TWINS = [
  'packages/assistant-service/src/node-workspace/database-location.ts',
  'packages/db/src/database-snapshot-manifest.ts',
];

function reservedNameRegex(file) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  const match = /const WINDOWS_RESERVED_DEVICE_NAME = \/(.+)\/([a-z]*);/u.exec(source);
  assert.ok(match, `${file} declares no WINDOWS_RESERVED_DEVICE_NAME`);
  return { flags: match[2], source: match[1] };
}

test('the manifest and the desktop resolver reject the same Windows device names', () => {
  const [desktop, manifest] = TWINS.map(reservedNameRegex);
  assert.equal(manifest.source, desktop.source);
  // Windows is case-insensitive, so the manifest twin must be too.
  assert.ok(manifest.flags.includes('i'));
});
