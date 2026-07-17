/**
 * Persona discovery IPC: built-ins + user personas (valid AND invalid) in one
 * list for the settings panel. Mirrors ipc-user-commands-handlers coverage.
 */

import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetUserPersonaWarningsForTests } from '../../assistant-server/user-personas-loader';
import { listUserPersonas } from '../../ipc-user-personas-handlers';

const HOME = '/home/user';

function makeFs(dirs: Record<string, Record<string, string>>) {
  return {
    listDir: (absDir: string) => {
      const files = dirs[absDir];
      if (!files) {
        return null;
      }
      return {
        entries: Object.keys(files).map((name) => ({
          isDirectory: false,
          isFile: true,
          name,
        })),
        inspected: Object.keys(files).length,
        truncated: false,
      };
    },
    readFile: (absFile: string) => {
      for (const [dir, files] of Object.entries(dirs)) {
        for (const [name, content] of Object.entries(files)) {
          if (`${dir}/${name}` === absFile) {
            return { content, ok: true } as const;
          }
        }
      }
      return { ok: false, reason: 'unreadable' } as const;
    },
  };
}

beforeEach(() => {
  __resetUserPersonaWarningsForTests();
});

describe('listUserPersonas', () => {
  it('lists built-ins first, then user personas with source metadata', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'sec.md': '---\ndescription: security\nmodel: anthropic::claude-haiku-4-5\n---\nBody.',
        },
      }),
      getDatabase: () => Promise.resolve(null),
      homedir: () => HOME,
    });

    const builtInRows = result.personas.slice(0, BUILT_IN_PERSONAS.length);
    expect(builtInRows.map((row) => row.id)).toEqual(BUILT_IN_PERSONAS.map((p) => p.id));
    expect(builtInRows.every((row) => row.source === 'built-in' && row.status === 'ok')).toBe(true);

    const userRow = result.personas.at(-1);
    expect(userRow).toMatchObject({
      id: 'sec',
      modelPin: 'anthropic::claude-haiku-4-5',
      source: 'user',
      status: 'ok',
    });
    expect(userRow?.absPath).toBe(`${HOME}/.brainstrike/agents/sec.md`);
  });

  it('includes invalid user persona files with their error', async () => {
    const result = await listUserPersonas({
      fs: makeFs({
        [`${HOME}/.brainstrike/agents`]: {
          'bad.md': '---\ndescription: d\ntools: writeWorkspaceFile\n---\nBody.',
        },
      }),
      getDatabase: () => Promise.resolve(null),
      homedir: () => HOME,
    });
    const invalid = result.personas.find((row) => row.status === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.error).toMatch(/read/i);
    expect(invalid?.source).toBe('user');
  });

  it('returns only built-ins when no persona dirs exist', async () => {
    const result = await listUserPersonas({
      fs: makeFs({}),
      getDatabase: () => Promise.resolve(null),
      homedir: () => HOME,
    });
    expect(result.personas).toHaveLength(BUILT_IN_PERSONAS.length);
  });
});
