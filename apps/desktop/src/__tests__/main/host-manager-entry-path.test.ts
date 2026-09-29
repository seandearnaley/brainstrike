import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({}),
  };
});

import { resolveDbHostEntryPath } from '../../db-host-manager';
import { resolveParserHostEntryPath } from '../../parser-host-manager';

const PACKAGED_MAIN_PATH = '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist/main.js';
const PACKAGED_DIST_PATH = '/Applications/Brainstrike.app/Contents/Resources/app.asar/dist';

describe('resolveDbHostEntryPath', () => {
  it('resolves from the current bundled module filename when called without an override', () => {
    expect(() => resolveDbHostEntryPath()).not.toThrow();
  });

  it('resolves the emitted DB host entry next to main.js', () => {
    expect(resolveDbHostEntryPath('/repo/apps/desktop/dist/main.js')).toBe(
      path.join('/repo/apps/desktop/dist', 'db-host-entry.js')
    );
  });

  it('tracks a differently-shaped module path without adding a dist segment', () => {
    expect(resolveDbHostEntryPath('/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c/dist', 'db-host-entry.js')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd', () => {
    expect(() => resolveDbHostEntryPath('')).toThrow('DB host entry: __filename unavailable');
  });

  it('preserves the packaged app.asar sibling path', () => {
    expect(resolveDbHostEntryPath(PACKAGED_MAIN_PATH)).toBe(
      path.join(PACKAGED_DIST_PATH, 'db-host-entry.js')
    );
  });
});

describe('resolveParserHostEntryPath', () => {
  it('resolves from the current bundled module filename when called without an override', () => {
    expect(() => resolveParserHostEntryPath()).not.toThrow();
  });

  it('resolves the emitted parser host entry next to main.js', () => {
    expect(resolveParserHostEntryPath('/repo/apps/desktop/dist/main.js')).toBe(
      path.join('/repo/apps/desktop/dist', 'parser-host-entry.js')
    );
  });

  it('tracks a differently-shaped module path without adding a dist segment', () => {
    expect(resolveParserHostEntryPath('/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c/dist', 'parser-host-entry.js')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd', () => {
    expect(() => resolveParserHostEntryPath('')).toThrow(
      'Parser host entry: __filename unavailable'
    );
  });

  it('preserves the packaged app.asar sibling path', () => {
    expect(resolveParserHostEntryPath(PACKAGED_MAIN_PATH)).toBe(
      path.join(PACKAGED_DIST_PATH, 'parser-host-entry.js')
    );
  });
});
