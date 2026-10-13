import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerContextFilesIpcHandlers } from '../../ipc-context-files';
import { registerHooksIpcHandlers } from '../../ipc-hooks';
import { registerSkillsIpcHandlers } from '../../ipc-skills';
import { registerUserCommandsIpcHandlers } from '../../ipc-user-commands';
import { createTrustedInvokeEvent } from '../helpers/desktop-ipc-sender-test-helpers';
import { mockIpcMain, resetElectronMainTestHarness } from '../helpers/electron-main-test-harness';

const postgres = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('PGlite unavailable');
  })
);
vi.mock('../../db-main', () => ({ getDatabase: postgres }));
let root: string;
const disposers: (() => void)[] = [];
beforeEach(() => {
  resetElectronMainTestHarness();
  postgres.mockClear();
  root = mkdtempSync(join(tmpdir(), 'bs-root-catalog-ipc-'));
  const home = join(root, 'disposable-home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  mkdirSync(join(root, '.brainstrike/commands'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'Use the canonical root.');
  mkdirSync(join(root, '.brainstrike/skills/review'), { recursive: true });
  writeFileSync(
    join(root, '.brainstrike/skills/review/SKILL.md'),
    '---\nname: review\ndescription: Review changes.\n---\nInspect changes.'
  );
  writeFileSync(join(root, '.brainstrike/hooks.json'), '{"PreToolUse":[]}');
  writeFileSync(join(root, '.brainstrike/commands/review.md'), 'Review $ARGUMENTS');
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  rmSync(root, { force: true, recursive: true });
  vi.unstubAllEnvs();
});
function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = mockIpcMain.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) {
    throw new Error(`Unregistered channel ${channel}`);
  }
  return handler(createTrustedInvokeEvent(), ...args);
}
function catalog(): WorkspaceRootPort {
  return {
    workspaceRoots: vi.fn<WorkspaceRootPort['workspaceRoots']>(async () => ({
      roots: [
        {
          createdAt: 1,
          displayName: 'Workspace',
          id: 'root-one',
          kind: 'path',
          lastVerifiedAt: 1,
          path: root,
          status: 'live',
        },
      ],
    })),
  };
}
it('reviews and trusts canonical hooks without PGlite', async () => {
  const roots = catalog();
  const trust = {
    approval: vi.fn(async () => undefined),
    trust: vi.fn(async () => {}),
    untrust: vi.fn(async () => {}),
  };
  disposers.push(registerHooksIpcHandlers(trust, roots));
  await expect(
    invoke('hooks:get-project-hooks-for-review', 'root-one', root)
  ).resolves.toMatchObject({ dbRootId: 'root-one', exists: true });
  await invoke('hooks:trust-project-hooks', root, 'a'.repeat(64));
  expect(trust.trust).toHaveBeenCalledWith({
    path: root,
    rootId: 'root-one',
    sha256: 'a'.repeat(64),
  });
  expect(roots.workspaceRoots).toHaveBeenCalledWith({ operation: 'list' });
  expect(postgres).not.toHaveBeenCalled();
});
it('scans instructions and commands through the required catalog without PGlite', async () => {
  const roots = catalog();
  disposers.push(
    registerContextFilesIpcHandlers(roots),
    registerUserCommandsIpcHandlers(roots),
    registerSkillsIpcHandlers(roots)
  );
  await expect(invoke('context-files:scan')).resolves.toMatchObject({
    ok: true,
    value: [{ fileName: 'AGENTS.md', rootId: 'root-one', status: 'fits' }],
  });
  await expect(invoke('user-commands:list')).resolves.toMatchObject({
    ok: true,
    value: {
      commands: expect.arrayContaining([
        { id: 'review', label: 'review', sourceRootId: 'root-one', template: 'Review $ARGUMENTS' },
      ]),
      roots: [{ displayName: 'Workspace', id: 'root-one' }],
    },
  });
  await expect(invoke('skills:scan')).resolves.toMatchObject({
    ok: true,
    value: {
      entries: [
        expect.objectContaining({ name: 'review', sourceRootId: 'root-one', status: 'ok' }),
      ],
    },
  });
  expect(roots.workspaceRoots).toHaveBeenCalledTimes(3);
  expect(postgres).not.toHaveBeenCalled();
});
it('reports catalog unavailability instead of empty successful discovery', async () => {
  const roots: WorkspaceRootPort = {
    workspaceRoots: vi.fn(async () => {
      throw new Error('Catalog unavailable');
    }),
  };
  disposers.push(
    registerContextFilesIpcHandlers(roots),
    registerUserCommandsIpcHandlers(roots),
    registerSkillsIpcHandlers(roots)
  );
  await expect(invoke('context-files:scan')).resolves.toMatchObject({ ok: false });
  await expect(invoke('user-commands:list')).resolves.toMatchObject({ ok: false });
  await expect(invoke('skills:scan')).resolves.toMatchObject({ ok: false });
  expect(roots.workspaceRoots).toHaveBeenCalledTimes(3);
  expect(postgres).not.toHaveBeenCalled();
});
