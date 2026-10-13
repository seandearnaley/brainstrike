import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  type ReferencedFileFailure,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import { scriptedModel } from '../src/test-fixtures/scripted-model.js';
import { HostRunNotices } from '../src/thread-view.js';

// Safe payloads observed from the real missing/outside symlink reader in desktop's paired test.
const files: ReferencedFileFailure[] = [
  {
    failure: {
      category: 'input',
      code: 'tool.input-invalid',
      kind: 'refusal',
      message: 'Path "missing.txt" does not exist.',
    },
    path: 'missing.txt',
    rootId: 'root-1',
  },
  {
    failure: {
      category: 'input',
      code: 'tool.input-invalid',
      kind: 'refusal',
      message: 'Path "dangling.txt" is outside the selected workspace root.',
    },
    path: 'dangling.txt',
    rootId: 'root-1',
  },
];
test('Core commits one attachment failure batch at admission, retained after reopen without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-reference-core-'));
  let store = await StateStore.open(root);
  const model = scriptedModel();
  const platform: HostPlatform = {
    admitRun: async () => ({
      configuration: {},
      model,
      referencedFileFailures: files,
      snapshot: { configuration: {}, maxSteps: 1, toolIdentities: {} },
      tools: {},
    }),
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  };
  let core = await HostCore.open(store, platform, () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const command = {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Read the two references',
      threadId,
    };
    const { runId } = await core.startRun(command);
    await expect
      .poll(async () =>
        (await core.read(threadId, 0)).some((row) => row.event.type === 'run.finished')
      )
      .toBe(true);
    const rows = await core.read(threadId, 0);
    const notices = rows.filter((row) => row.event.type === 'references.unavailable');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.event).toEqual({ files, runId, type: 'references.unavailable' });
    const started = rows.findIndex((row) => row.event.type === 'run.started');
    expect(rows[started + 1]?.event.type).toBe('references.unavailable');
    expect(new HostRunNotices().read(notices[0]!)).toEqual(
      files.map(
        (file) => `Referenced file could not be attached: ${file.path}: ${file.failure.message}`
      )
    );
    const calls = model.doStreamCalls.length;
    await core.startRun(command);
    expect(
      (await core.read(threadId, 0)).filter((row) => row.event.type === 'references.unavailable')
    ).toEqual(notices);
    await core.close();
    await store.close();
    store = await StateStore.open(root);
    core = await HostCore.open(store, platform, () => () => undefined);
    expect(
      (await core.read(threadId, 0)).filter((row) => row.event.type === 'references.unavailable')
    ).toEqual(notices);
    expect(model.doStreamCalls).toHaveLength(calls);
  } finally {
    await core.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  }
});
