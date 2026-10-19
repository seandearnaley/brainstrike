import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { runFixtureProcess } from './fixtures/fixture-process.js';

const child = path.join(import.meta.dirname, 'fixtures/node-workspace-native-child.mjs');

for (const mode of ['cold', 'revoke']) {
  test(`actual plain Node selected profile/catalog and pinned source: ${mode}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'bs-node-workspace-native-'));
    try {
      expect(await runFixtureProcess(child, ['seed', fixture])).toMatchObject({
        electron: false,
        seeded: true,
      });
      expect(await runFixtureProcess(child, [mode, fixture])).toMatchObject({
        aliasRefused: true,
        catalogPreserved: true,
        electron: false,
        joined: true,
        mode,
        sameLease: true,
        secondWriterRefused: true,
        wrongProfileRefused: true,
      });
    } finally {
      const owner = RootLock.inspect(path.join(fixture, 'profiles', 'selected'));
      if (!owner || owner.owner.released) {
        await rm(fixture, { force: true, recursive: true });
      }
    }
  }, 60_000);
}
