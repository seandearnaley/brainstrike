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

  /**
   * BST-936 — the three defects the #2034 lens review found here first. Each
   * is a "silently different behaviour" bug, which is the class this codebase
   * refuses everywhere else.
   */
  it('a BROKEN project persona blocks a same-named global one — no silent fallback', () => {
    // The bug: the project file failed to parse, never reserved `reviewer`,
    // and the GLOBAL file then loaded under that id — so a broken project
    // persona silently swapped in different instructions under the name the
    // project author controls. The id comes from the FILENAME
    // (deriveUserPersonaId), so it can be reserved before parsing.
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': {
        'reviewer.md': personaFile('project reviewer', 'tools: writeWorkspaceFile'),
      },
      [`${HOME}/.brainstrike/agents`]: { 'reviewer.md': personaFile('global reviewer') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);

    expect(result.personas).toHaveLength(0);
    const [broken, suppressed] = result.entries;
    expect(broken).toMatchObject({ sourceRootId: 'root-a', status: 'invalid' });
    // The global file is reported as shadowed BY the broken project file —
    // naming the winner's path, the author's actual question.
    expect(suppressed).toMatchObject({
      absPath: `${HOME}/.brainstrike/agents/reviewer.md`,
      shadowedBy: { absPath: '/work/a/.brainstrike/agents/reviewer.md', sourceRootId: 'root-a' },
      status: 'shadowed',
    });
  });

  it('a suppressed duplicate is VISIBLE in shadowed, not merely logged', () => {
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': { 'reviewer.md': personaFile('project reviewer') },
      [`${HOME}/.brainstrike/agents`]: { 'reviewer.md': personaFile('global reviewer') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);

    expect(result.personas).toHaveLength(1);
    expect(result.personas[0]?.description).toBe('project reviewer');
    const suppressed = result.entries.find((entry) => entry.status === 'shadowed');
    expect(suppressed).toMatchObject({
      absPath: `${HOME}/.brainstrike/agents/reviewer.md`,
      shadowedBy: { absPath: '/work/a/.brainstrike/agents/reviewer.md', sourceRootId: 'root-a' },
    });
  });

  it('a built-in collision does NOT reserve — both files get the accurate error', () => {
    // Reserving through only the derivation half would report the second file
    // as "shadowed by another file" when the truth is that a BUILT-IN owns
    // the name and neither can ever load (#2035 review).
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': { 'explore.md': personaFile('shadow explore') },
      [`${HOME}/.brainstrike/agents`]: { 'explore.md': personaFile('also explore') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);

    expect(result.personas).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
    for (const entry of result.entries) {
      expect(entry.status).toBe('invalid');
      expect(entry.status === 'invalid' && entry.error).toMatch(/built-in/i);
    }
  });

  it('an exhausted cap reports the directories it skipped', () => {
    // The entries-based cap is the right bound, but it must not silently
    // starve later tiers: 50 malformed files in a root would otherwise make
    // the user's long-standing GLOBAL personas simply stop existing, with
    // one main-process log line as the only trace (#2035 review).
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_USER_PERSONAS_SCAN; index += 1) {
      files[`p${String(index).padStart(3, '0')}.md`] = 'no frontmatter at all';
    }
    const deps = makeDeps({
      '/work/a/.brainstrike/agents': files,
      [`${HOME}/.brainstrike/agents`]: { 'mine.md': personaFile('my global persona') },
    });
    const result = scanUserPersonas({ homeDir: HOME, roots: [ROOT_A] }, deps);

    expect(result.personas).toHaveLength(0);
    expect(result.incompleteDirs).toEqual([
      { dir: `${HOME}/.brainstrike/agents`, reason: 'cap-reached' },
    ]);
  });

  it('invalid files consume the scan cap — a malformed dir cannot extend the scan', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_USER_PERSONAS_SCAN + 5; index += 1) {
      // Valid filename (so the id is reserved) but an invalid body.
      files[`p${String(index).padStart(3, '0')}.md`] = 'no frontmatter at all';
    }
    const deps = makeDeps({ [`${HOME}/.brainstrike/agents`]: files });
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);

    expect(result.personas).toHaveLength(0);
    expect(result.entries).toHaveLength(MAX_USER_PERSONAS_SCAN);
  });

  it('a truncated directory listing is reported, never silent', () => {
    const deps: UserPersonaScanDeps = {
      listDir: () => ({
        entries: [{ isDirectory: false, isFile: true, name: 'ok.md' }],
        inspected: 1,
        truncated: true,
      }),
      readFile: () => ({ content: personaFile('present'), ok: true }),
    };
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);

    expect(result.personas).toHaveLength(1);
    expect(result.incompleteDirs).toEqual([
      { dir: `${HOME}/.brainstrike/agents`, reason: 'listing-truncated' },
    ]);
  });

  it('junk files do not evict real personas from the listing', () => {
    // The listing bound counts DIRECTORY ENTRIES, so it must not be derived
    // from the persona cap: a directory padded with non-.md files would
    // otherwise push real personas past the requested maxEntries.
    const junk = Array.from({ length: MAX_USER_PERSONAS_SCAN + 5 }, (_, index) => ({
      isDirectory: false,
      isFile: true,
      name: `notes-${index}.txt`,
    }));
    const deps: UserPersonaScanDeps = {
      listDir: (_absDir, _containmentRoot, maxEntries) => {
        const all = [...junk, { isDirectory: false, isFile: true, name: 'real.md' }];
        const kept = all.slice(0, maxEntries);
        return { entries: kept, inspected: kept.length, truncated: kept.length < all.length };
      },
      readFile: () => ({ content: personaFile('the real one'), ok: true }),
    };
    const result = scanUserPersonas({ homeDir: HOME, roots: [] }, deps);

    expect(result.personas.map((persona) => persona.id)).toEqual(['real']);
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
