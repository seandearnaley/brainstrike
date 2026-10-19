import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { runFixtureProcess } from './fixtures/fixture-process.js';

const seed = path.join(import.meta.dirname, 'fixtures/node-workspace-native-child.mjs');
const child = path.join(import.meta.dirname, 'fixtures/node-workspace-root-identity-child.mjs');

/** The receipt fields these assertions cross-reference; toMatchObject checks the rest. */
interface RootIdentityReport {
  readonly grantReads: number;
  readonly profileA: string;
  readonly profileB: string;
  readonly rejection?: string;
}

for (const mode of ['retarget', 'stable-alias']) {
  test(`actual StateStore captured profile identity through a presentation alias: ${mode}`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'bs-node-workspace-root-identity-'));
    try {
      for (const name of ['a', 'b']) {
        const root = path.join(fixture, name);
        await mkdir(root);
        expect(await runFixtureProcess(seed, ['seed', root])).toMatchObject({
          electron: false,
          seeded: true,
        });
      }
      const report = (await runFixtureProcess(child, [mode, fixture])) as RootIdentityReport;
      expect(report).toMatchObject({ electron: false, mode, physicallyJoined: true });
      if (mode === 'retarget') {
        expect(report).toMatchObject({
          capturedRoot: report.profileA,
          grantReads: 0,
          opened: false,
          pgLockDuringAttempt: false,
          selectedProfile: report.profileB,
        });
        expect(report.rejection).toMatch(/acquired canonical Root/);
      } else {
        expect(report).toMatchObject({
          capturedRoot: report.profileA,
          catalogPaths: [path.join(fixture, 'a', 'workspace')],
          opened: true,
          pgLockDuringAttempt: false,
          selectedProfile: report.profileA,
        });
        expect(report.grantReads).toBeGreaterThan(0);
        expect(report.rejection).toBeUndefined();
      }
    } finally {
      const owners = ['a', 'b'].map((name) =>
        RootLock.inspect(path.join(fixture, name, 'profiles', 'selected'))
      );
      if (owners.every((owner) => !owner || owner.owner.released)) {
        await rm(fixture, { force: true, recursive: true });
      }
    }
  }, 60_000);
}
