import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RootLock } from '@brainstrike/state-store';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
const child = path.join(import.meta.dirname, 'fixtures/node-workspace-native-child.mjs');

for (const mode of ['cold', 'revoke']) {
  test(`actual plain Node selected profile/catalog and pinned source: ${mode}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'bs-node-workspace-native-'));
    try {
      const seeded = await execute(process.execPath, [child, 'seed', fixture]);
      expect(JSON.parse(seeded.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
        electron: false,
        seeded: true,
      });
      const result = await execute(process.execPath, [child, mode, fixture]);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
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
