import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_HOTSPOT_PACKAGES,
  buildProfileCommand,
  parseArgs,
} from '../profile-vitest-hotspots.mjs';

test('parseArgs defaults to the known slow packages with coverage enabled', () => {
  const options = parseArgs([]);

  assert.equal(options.coverage, true);
  assert.deepEqual(options.packages, DEFAULT_HOTSPOT_PACKAGES);
});

test('parseArgs accepts explicit packages and no-coverage mode', () => {
  const options = parseArgs(['--package', '@brainstrike/web', '--no-coverage']);

  assert.equal(options.coverage, false);
  assert.deepEqual(options.packages, ['@brainstrike/web']);
});

test('buildProfileCommand appends import duration profiling to package scripts', () => {
  const [command, args] = buildProfileCommand('@brainstrike/app-shell', { coverage: true });

  assert.equal(command, 'pnpm');
  assert.deepEqual(args, [
    '--filter',
    '@brainstrike/app-shell',
    'run',
    'test:coverage',
    '--experimental.importDurations.print',
  ]);
});

test('parseArgs rejects missing package names', () => {
  assert.throws(() => parseArgs(['--package']), /--package requires a package name/);
});
