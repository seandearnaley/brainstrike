/**
 * User-defined persona discovery (desktop main). Mirrors the
 * user-slash-commands-loader posture: injected fs, bounded scan, first-wins
 * dedupe with visible warns, and fail-closed parsing — an invalid persona file
 * becomes a VISIBLE invalid entry (settings panel), never a silent skip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetUserPersonaWarningsForTests,
  MAX_USER_PERSONAS_SCAN,
  scanUserPersonas,
  type UserPersonaScanDeps,
} from '../../assistant-server/user-personas-loader';

const HOME = '/home/user';
const ROOT_A = { absPath: '/work/a', displayName: 'A', id: 'root-a' };
const ROOT_B = { absPath: '/work/b', displayName: 'B', id: 'root-b' };

function personaFile(description: string, extra = ''): string {
  return `---\ndescription: ${description}\n${extra}\n---\nDo the thing.`;
}

/** Build injected fs deps from a map of absolute dir → { fileName: content }. */
function makeDeps(dirs: Record<string, Record<string, string>>): UserPersonaScanDeps {
  return {
    listDir: (absDir) => {
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
    readFile: (absFile) => {
      for (const [dir, files] of Object.entries(dirs)) {
        for (const [name, content] of Object.entries(files)) {
          if (`${dir}/${name}` === absFile) {
            return { content, ok: true };
          }
        }
      }
      return { ok: false, reason: 'unreadable' };
    },
  };
}

beforeEach(() => {
  __resetUserPersonaWarningsForTests();
});

describe('scanUserPersonas', () => {
  it('discovers valid personas from a root tier with source metadata', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': {
        'security-auditor.md': personaFile('Audits security'),
      },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]).toMatchObject({
      description: 'Audits security',
      id: 'security-auditor',
      source: 'user',
    });
    const entry = result.entries[0];
    expect(entry).toMatchObject({
      sourceRootId: 'root-a',
      status: 'ok',
    });
  });

  it('project tier beats the global tier for the same id (first-wins + warn once)', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': {
        'reviewer.md': personaFile('project reviewer'),
      },
      [`${HOME}/.brainstrike/agents`]: {
        'reviewer.md': personaFile('global reviewer'),
      },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]?.description).toBe('project reviewer');
  });

  it('cross-root collision keeps the first-mounted root', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': { 'x.md': personaFile('from a') },
      '/work/b/.brainstrike/agents': { 'x.md': personaFile('from b') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A, ROOT_B] }, deps);
    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]?.description).toBe('from a');
  });

  it('surfaces an invalid persona file as an invalid entry, not a silent skip', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': {
        'bad.md': personaFile('names a write tool', 'tools: writeWorkspaceFile'),
        'good.md': personaFile('fine'),
      },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.personas.map((persona) => persona.id)).toEqual(['good']);
    const invalid = result.entries.find((entry) => entry.status === 'invalid');
    expect(invalid).toBeDefined();
    expect(invalid?.status === 'invalid' && invalid.error).toMatch(/read/i);
    expect(invalid?.fileName).toBe('bad.md');
  });

  it('a built-in persona id collision is an invalid entry (built-ins win)', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': { 'explore.md': personaFile('shadow explore') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.personas).toHaveLength(0);
    const invalid = result.entries.find((entry) => entry.status === 'invalid');
    expect(invalid?.status === 'invalid' && invalid.error).toMatch(/built-in/i);
  });

  it('ignores non-markdown files and subdirectories (flat scan)', () => {
    const deps: UserPersonaScanDeps = {
      listDir: () => ({
        entries: [
          { isDirectory: true, isFile: false, name: 'nested' },
          { isDirectory: false, isFile: true, name: 'notes.txt' },
          { isDirectory: false, isFile: true, name: 'ok.md' },
        ],
        inspected: 3,
        truncated: false,
      }),
      readFile: () => ({ content: personaFile('ok'), ok: true }),
    };
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);
    expect(result.personas.map((persona) => persona.id)).toEqual(['ok']);
  });

  it('caps the number of accepted personas', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_USER_PERSONAS_SCAN + 5; index += 1) {
      files[`p${String(index).padStart(3, '0')}.md`] = personaFile(`persona ${index}`);
    }
    const deps = makeDeps({ [`${HOME}/.brainstrike/agents`]: files });
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);
    expect(result.personas).toHaveLength(MAX_USER_PERSONAS_SCAN);
  });

  it('an unreadable file is an invalid entry with an honest reason', () => {
    const deps: UserPersonaScanDeps = {
      listDir: () => ({
        entries: [{ isDirectory: false, isFile: true, name: 'gone.md' }],
        inspected: 1,
        truncated: false,
      }),
      readFile: () => ({ ok: false, reason: 'unreadable' }),
    };
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);
    expect(result.personas).toHaveLength(0);
    const invalid = result.entries[0];
    expect(invalid?.status === 'invalid' && invalid.error).toMatch(/read/i);
  });
});
