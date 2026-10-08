import { constants } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(() => ({ isFile: () => false, size: 0 })),
  openSync: vi.fn(() => 42),
  readSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  const modWithDefault = mod as typeof mod & { default: typeof mod };
  return {
    ...mod,
    ...fsMocks,
    default: { ...modWithDefault.default, ...fsMocks },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

it('opens project hook configs nonblocking so a FIFO cannot pin Electron main', async () => {
  const { readProjectHookConfig } = await import('../../src/hooks/config.js');
  readProjectHookConfig('/workspace/.brainstrike/hooks.json');

  expect(fsMocks.openSync).toHaveBeenCalledWith(
    '/workspace/.brainstrike/hooks.json',
    constants.O_RDONLY | constants.O_NONBLOCK
  );
});
