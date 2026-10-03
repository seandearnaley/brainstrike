/**
 * Lens discovery (desktop main) — BST-921. Mirrors the persona-loader
 * posture: injected fs, bounded scan, first-wins dedupe with visible warns,
 * and fail-closed parsing — an invalid lens file becomes a VISIBLE invalid
 * entry (surfaced by mode: 'listLenses'), never a silent skip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetUserLensWarningsForTests,
  MAX_USER_LENSES_SCAN,
  scanUserLenses,
  type UserLensScanDeps,
} from '../../assistant-server/lens-loader';

const HOME = '/home/user';
const ROOT_A = { absPath: '/work/a', displayName: 'A', id: 'root-a' };
const ROOT_B = { absPath: '/work/b', displayName: 'B', id: 'root-b' };

function lensFile(description: string): string {
  return `-- description: ${description}\n-- target: index\n-- param: symbol text  Seed symbol\nSELECT name FROM file_symbols WHERE name = $1`;
}

/** Build injected fs deps from a map of absolute dir → { fileName: content }. */
function makeDeps(dirs: Record<string, Record<string, string>>): UserLensScanDeps {
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
  __resetUserLensWarningsForTests();
});

describe('scanUserLenses', () => {
  it('discovers valid lenses from a root tier with source metadata', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': {
        'callers-hybrid.sql': lensFile('Caller-graph retrieval'),
      },
    });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.lenses).toHaveLength(1);
    expect(result.lenses[0]).toMatchObject({
      description: 'Caller-graph retrieval',
      id: 'callers-hybrid',
    });
    expect(result.lenses[0]?.params).toEqual([
      { description: 'Seed symbol', name: 'symbol', type: 'text' },
    ]);
    expect(result.entries[0]).toMatchObject({ sourceRootId: 'root-a', status: 'ok' });
  });

  it('project tier beats the global tier for the same id (first-wins, shadow VISIBLE)', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': { 'shared.sql': lensFile('project lens') },
      [`${HOME}/.brainstrike/lenses`]: { 'shared.sql': lensFile('global lens') },
    });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.lenses).toHaveLength(1);
    expect(result.lenses[0]?.description).toBe('project lens');
    // The duplicate is an ENTRY naming the winner (converged with the
    // persona loader / skill-scan shape).
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({
      shadowedBy: { absPath: '/work/a/.brainstrike/lenses/shared.sql', sourceRootId: 'root-a' },
      status: 'shadowed',
    });
  });

  it('a BROKEN project lens blocks a same-named global lens — no silent fallback', () => {
    // The id is reserved from the FILENAME before parsing: a malformed
    // project-tier file must never let a global file's different SQL run
    // under the id the project author thinks they control (#2034 P1).
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': { 'shared.sql': 'SELECT 1' }, // no header
      [`${HOME}/.brainstrike/lenses`]: { 'shared.sql': lensFile('global lens') },
    });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.lenses).toHaveLength(0);
    const [broken, suppressed] = result.entries;
    expect(broken).toMatchObject({ sourceRootId: 'root-a', status: 'invalid' });
    expect(suppressed).toMatchObject({
      shadowedBy: { absPath: '/work/a/.brainstrike/lenses/shared.sql', sourceRootId: 'root-a' },
      status: 'shadowed',
    });
  });

  it('invalid files consume the scan cap — malformed dirs cannot extend the scan', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_USER_LENSES_SCAN + 5; i += 1) {
      files[`broken-${String(i).padStart(3, '0')}.sql`] = 'SELECT 1'; // all invalid
    }
    const deps = makeDeps({ '/work/a/.brainstrike/lenses': files });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.entries).toHaveLength(MAX_USER_LENSES_SCAN);
    expect(result.lenses).toHaveLength(0);
  });

  it('a truncated directory listing is reported, never silent', () => {
    const deps: UserLensScanDeps = {
      listDir: (absDir) =>
        absDir === '/work/a/.brainstrike/lenses'
          ? {
              entries: [{ isDirectory: false, isFile: true, name: 'a.sql' }],
              inspected: 1,
              truncated: true,
            }
          : null,
      readFile: () => ({ content: lensFile('present'), ok: true }),
    };
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.incompleteDirs).toEqual([
      { dir: '/work/a/.brainstrike/lenses', reason: 'listing-truncated' },
    ]);
    expect(result.lenses).toHaveLength(1);
  });

  it('cross-root collision keeps the first-mounted root', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': { 'shared.sql': lensFile('from a') },
      '/work/b/.brainstrike/lenses': { 'shared.sql': lensFile('from b') },
    });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A, ROOT_B] }, deps);
    expect(result.lenses).toHaveLength(1);
    expect(result.lenses[0]?.description).toBe('from a');
  });

  it('an invalid lens file surfaces as an invalid entry, not a silent skip', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': {
        'broken.sql': 'SELECT 1', // no description header
        'good.sql': lensFile('works'),
      },
    });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.lenses).toHaveLength(1);
    const broken = result.entries.find((entry) => entry.fileName === 'broken.sql');
    expect(broken?.status).toBe('invalid');
    if (broken?.status === 'invalid') {
      expect(broken.error).toMatch(/description/i);
    }
  });

  it('an unreadable file surfaces as an invalid entry with an honest reason', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/lenses': { 'ghost.sql': lensFile('never readable') },
    });
    const failingDeps: UserLensScanDeps = {
      listDir: deps.listDir,
      readFile: () => ({ ok: false, reason: 'unreadable' }),
    };
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, failingDeps);
    expect(result.lenses).toHaveLength(0);
    expect(result.entries[0]).toMatchObject({ status: 'invalid' });
  });

  it('ignores non-sql files and directories (flat scan)', () => {
    const deps: UserLensScanDeps = {
      listDir: (absDir) => {
        if (absDir !== '/work/a/.brainstrike/lenses') {
          return null;
        }
        return {
          entries: [
            { isDirectory: false, isFile: true, name: 'notes.md' },
            { isDirectory: true, isFile: false, name: 'nested' },
            { isDirectory: false, isFile: true, name: 'real.sql' },
          ],
          inspected: 3,
          truncated: false,
        };
      },
      readFile: (absFile) =>
        absFile.endsWith('real.sql')
          ? { content: lensFile('the real one'), ok: true }
          : { ok: false, reason: 'unreadable' },
    };
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.entries).toHaveLength(1);
    expect(result.lenses[0]?.id).toBe('real');
  });

  it('stops accepting lenses at the count cap', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_USER_LENSES_SCAN + 5; i += 1) {
      files[`lens-${String(i).padStart(3, '0')}.sql`] = lensFile(`lens ${i}`);
    }
    const deps = makeDeps({ '/work/a/.brainstrike/lenses': files });
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, deps);
    expect(result.lenses).toHaveLength(MAX_USER_LENSES_SCAN);
  });

  it('returns empty results when no lens directories exist', () => {
    const result = scanUserLenses({ homeDir: HOME, roots: [ROOT_A] }, makeDeps({}));
    expect(result.entries).toEqual([]);
    expect(result.lenses).toEqual([]);
  });
});
