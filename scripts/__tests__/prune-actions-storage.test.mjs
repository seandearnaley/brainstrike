import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseArgs,
  selectArtifactsForDeletion,
  selectCachesForDeletion,
} from '../prune-actions-storage.mjs';

const now = new Date('2026-05-03T12:00:00Z');

test('parseArgs reads retention options and dry-run mode', () => {
  const options = parseArgs(
    [
      '--repo',
      'owner/repo',
      '--artifact-max-age-hours',
      '12',
      '--cache-max-age-hours',
      '48',
      '--cache-keep-recent-per-key',
      '1',
      '--dry-run',
    ],
    {}
  );

  assert.deepEqual(options, {
    artifactMaxAgeHours: 12,
    cacheKeepRecentPerKey: 1,
    cacheMaxAgeHours: 48,
    dryRun: true,
    repo: 'owner/repo',
  });
});

test('selectArtifactsForDeletion keeps fresh artifacts and deletes expired or old artifacts', () => {
  const artifacts = [
    { id: 1, created_at: '2026-05-03T00:30:00Z', expired: false },
    { id: 2, created_at: '2026-05-02T11:59:00Z', expired: false },
    { id: 3, created_at: '2026-05-03T11:30:00Z', expired: true },
  ];

  assert.deepEqual(
    selectArtifactsForDeletion(artifacts, { artifactMaxAgeHours: 24, now }).map(
      (artifact) => artifact.id
    ),
    [2, 3]
  );
});

test('selectCachesForDeletion removes stale caches and duplicate exact keys beyond retention', () => {
  const caches = [
    { id: 1, key: 'pnpm-a', last_accessed_at: '2026-05-03T11:30:00Z' },
    { id: 2, key: 'pnpm-a', last_accessed_at: '2026-05-03T10:30:00Z' },
    { id: 3, key: 'pnpm-a', last_accessed_at: '2026-05-03T09:30:00Z' },
    { id: 4, key: 'pnpm-b', last_accessed_at: '2026-04-30T11:59:00Z' },
    { id: 5, key: 'playwright', last_accessed_at: '2026-05-03T10:00:00Z' },
  ];

  assert.deepEqual(
    selectCachesForDeletion(caches, {
      cacheKeepRecentPerKey: 2,
      cacheMaxAgeHours: 72,
      now,
    }).map((cache) => cache.id),
    [3, 4]
  );
});

test('parseArgs rejects invalid retention values', () => {
  assert.throws(
    () => parseArgs(['--repo', 'owner/repo', '--cache-keep-recent-per-key', '1.5'], {}),
    /positive integer/
  );
  assert.throws(
    () => parseArgs(['--repo', 'owner/repo', '--artifact-max-age-hours', '0'], {}),
    /positive number/
  );
});
