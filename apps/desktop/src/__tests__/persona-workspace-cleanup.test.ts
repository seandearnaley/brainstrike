// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ElectronHarness } from '../../e2e/fixtures/electron-harness';
import { tearDownElectronTest } from '../../e2e/fixtures/electron-teardown';

const state = vi.hoisted(() => ({
  events: [] as string[],
  failure: new Error('persona flow failed after mounting its workspace'),
  held: false,
  mountedRoot: '',
  run: undefined as undefined | ((fixtures: Record<string, unknown>) => Promise<void>),
}));

vi.mock('../../e2e/fixtures/electron-fixture', () => ({
  test: (_title: string, run: NonNullable<typeof state.run>) => {
    state.run = run;
  },
}));
vi.mock('../../e2e/utils/seed-root', () => ({
  seedRoot: async (_page: unknown, root: string) => {
    state.mountedRoot = root;
    state.held = true;
    throw state.failure;
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === state.mountedRoot) {
        if (state.held) {
          throw Object.assign(new Error(`EBUSY: mounted workspace ${state.mountedRoot}`), {
            code: 'EBUSY',
          });
        }
        state.events.push('remove');
      }
      return fs.rm(...args);
    },
  };
});

await import('../../e2e/subagent-persona-availability.desktop.test');

it('keeps the persona workspace through failure capture and physical Electron retirement', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'bs-persona-owner-'));
  onTestFinished(async () => {
    state.held = false;
    await rm(workspaceRoot, { force: true, recursive: true });
    if (state.mountedRoot && state.mountedRoot !== workspaceRoot) {
      await rm(state.mountedRoot, { force: true, recursive: true });
    }
  });
  const harness = new ElectronHarness(undefined, undefined, undefined, undefined, workspaceRoot);
  if (!state.run) {
    throw new Error('persona spec was not registered');
  }
  await expect(state.run({ electron: harness, homePage: {}, window: {} })).rejects.toBe(
    state.failure
  );
  expect(state.mountedRoot).toBe(workspaceRoot);
  await expect(stat(workspaceRoot)).resolves.toBeDefined();

  const retiring = Promise.withResolvers<void>();
  const beganClose = Promise.withResolvers<void>();
  const page = {
    isClosed: () => false,
    screenshot: async () => {
      expect(state.held).toBe(true);
      await stat(workspaceRoot);
      state.events.push('screenshot');
      return Buffer.alloc(0);
    },
  } as unknown as Page;
  const teardown = tearDownElectronTest(
    {
      currentWindow: () => page,
      dispose: async () => {
        state.events.push('dispose');
        beganClose.resolve();
        await retiring.promise;
        state.held = false;
        state.events.push('retired');
      },
    },
    {
      attach: async () => undefined,
      expectedStatus: 'passed',
      outputPath: (name: string) => join(workspaceRoot, name),
      status: 'failed',
    },
    undefined,
    [workspaceRoot]
  );
  try {
    await beganClose.promise;
    expect(state.events).toEqual(['screenshot', 'dispose']);
    await expect(stat(workspaceRoot)).resolves.toBeDefined();
  } finally {
    retiring.resolve();
    await teardown;
  }
  expect(state.events).toEqual(['screenshot', 'dispose', 'retired', 'remove']);
  await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
