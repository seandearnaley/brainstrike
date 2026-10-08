import { expect, test } from 'vitest';
import {
  joinProfileDirectory,
  resolveExplicitDatabaseLocation,
} from '../node-workspace/database-location.js';

test('cold launch reuses canonical explicit override selection and profile layout', () => {
  const location = resolveExplicitDatabaseLocation({
    platform: 'darwin',
    profile: 'Feature/Owner',
    rootPath: '/tmp/explicit-existing-database',
  });
  expect(location).toEqual({
    profile: 'feature-owner',
    rootPath: '/tmp/explicit-existing-database',
    source: 'override',
  });
  expect(joinProfileDirectory(location.rootPath, location.profile)).toBe(
    '/tmp/explicit-existing-database/profiles/feature-owner'
  );
});

test.each(['', ' ', 'undefined', '.', '..', '-', 'nul', 'CON.txt', 'com1'])(
  'cold launch refuses an absent or unsafe explicit profile %j',
  (profile) => {
    expect(() =>
      resolveExplicitDatabaseLocation({
        platform: 'linux',
        profile,
        rootPath: '/tmp/explicit-existing-database',
      })
    ).toThrow();
  }
);

test.each(['', ' ', 'undefined', 'relative/database'])(
  'cold launch refuses an absent or relative explicit root %j',
  (rootPath) => {
    expect(() =>
      resolveExplicitDatabaseLocation({ platform: 'linux', profile: 'selected', rootPath })
    ).toThrow();
  }
);

test.each(['\\database', 'C:database', 'database'])(
  'cold launch refuses drive-relative Windows root %j',
  (rootPath) => {
    expect(() =>
      resolveExplicitDatabaseLocation({ platform: 'win32', profile: 'selected', rootPath })
    ).toThrow();
  }
);

test.each(['C:\\database', '\\\\server\\share\\database'])(
  'cold launch accepts fully qualified Windows root %j',
  (rootPath) => {
    expect(
      resolveExplicitDatabaseLocation({ platform: 'win32', profile: 'Selected', rootPath })
    ).toEqual({ profile: 'selected', rootPath, source: 'override' });
  }
);
