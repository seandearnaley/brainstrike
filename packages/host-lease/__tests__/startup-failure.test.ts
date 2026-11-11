/**
 * ADR-0017 (BST-2477): a host refused because a native process an earlier owner started still
 * holds the Root reports which owner that is, and its launcher reads it as that refusal. Once
 * another owner has taken the Root since, the report no longer describes it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock, RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { failedStartupReport, startupFailure } from '../src/startup-failure.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function finishedOwnerRoot(): Promise<{
  readonly previous: RootLock;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'bs-startup-failure-'));
  roots.push(root);
  const previous = await RootLock.acquire(root);
  previous.release();
  return { previous, root };
}

test("a host refused by an earlier owner's native process reports that owner, and its launcher reads it as that refusal", async () => {
  const { previous, root } = await finishedOwnerRoot();
  const report = failedStartupReport(new RootLockedError(previous.owner, 'native-tail'));
  expect(report).toMatchObject({
    kind: 'root-locked',
    nativeTail: {
      host: previous.owner.host,
      pid: previous.owner.pid,
      start: previous.owner.start,
      token: previous.owner.token,
    },
  });
  const refusal = startupFailure(root, report);
  expect(refusal).toBeInstanceOf(RootLockedError);
  expect(refusal).toMatchObject({
    holder: 'native-tail',
    owner: { pid: previous.owner.pid, token: previous.owner.token },
  });
});

test('the report no longer describes a Root another owner has taken since', async () => {
  const { previous, root } = await finishedOwnerRoot();
  const report = failedStartupReport(new RootLockedError(previous.owner, 'native-tail'));
  const next = await RootLock.acquire(root);
  try {
    const refusal = startupFailure(root, report);
    expect(refusal).toBeInstanceOf(RootLockedError);
    expect(refusal).toMatchObject({ holder: 'owner', owner: { token: next.owner.token } });
  } finally {
    next.release();
  }
});
