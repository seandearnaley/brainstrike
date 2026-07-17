/**
 * Skills scan IPC handler tests: entry → serializable summary mapping (ok /
 * invalid / shadowed, with durable preference keys and exact validation
 * errors) and DB-failure degradation to global-only scanning.
 */

import type { SkillContentDeps } from '@brainstrike/agent';
import { __resetSkillScanWarningsForTests } from '@brainstrike/agent';
import { beforeEach, describe, expect, it } from 'vitest';
import { scanSkillsForRenderer } from '../../ipc-skills-handlers';

interface MemoryFs {
  dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  files: Record<string, string>;
}

function makeFs(fs: MemoryFs): SkillContentDeps {
  return {
    listDir: (absDir, _containmentRoot, maxEntries) => {
      const entries = fs.dirs[absDir];
      if (!entries) {
        return null;
      }
      return {
        entries: entries.slice(0, maxEntries).map((entry) => ({
          isDirectory: entry.kind === 'dir',
          isFile: entry.kind === 'file',
          name: entry.name,
        })),
        inspected: Math.min(entries.length, maxEntries),
        truncated: entries.length > maxEntries,
      };
    },
    readFileBytes: () => ({ ok: false, reason: 'unreadable' }),
    readFileText: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

const FS: MemoryFs = {
  dirs: {
    '/home/user/.claude/skills': [
      { kind: 'dir', name: 'review' },
      { kind: 'dir', name: 'broken' },
    ],
    '/home/user/.claude/skills/broken': [{ kind: 'file', name: 'SKILL.md' }],
    '/home/user/.claude/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
    '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'review' }],
    '/proj/a/.brainstrike/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
  },
  files: {
    '/home/user/.claude/skills/broken/SKILL.md': '---\nname: not-broken\ndescription: Bad.\n---\nx',
    '/home/user/.claude/skills/review/SKILL.md':
      '---\nname: review\ndescription: Global review skill.\n---\nGlobal.',
    '/proj/a/.brainstrike/skills/review/SKILL.md':
      '---\nname: review\ndescription: Root review skill.\nuser-invocable: false\n---\nRoot.',
  },
};

const DB_WITH_ROOT = {
  // Minimal WorkspaceRootsQueryable-compatible stub: resolveScanRoots calls
  // loadWorkspaceRootsFromDatabase(db), which queries the roots table.
  query: (_sql: string) =>
    Promise.resolve({
      rows: [{ displayName: 'A', id: 'root-a', path: '/proj/a' }],
    }),
};

beforeEach(() => {
  __resetSkillScanWarningsForTests();
});

describe('scanSkillsForRenderer', () => {
  it('maps ok, shadowed, and invalid entries to serializable summaries', async () => {
    const result = await scanSkillsForRenderer({
      fs: makeFs(FS),
      getDatabase: () => Promise.resolve(DB_WITH_ROOT as never),
      homedir: () => '/home/user',
    });

    const byStatus = new Map(result.entries.map((entry) => [entry.status, entry]));
    const ok = byStatus.get('ok');
    expect(ok).toMatchObject({
      absPath: '/proj/a/.brainstrike/skills/review',
      description: 'Root review skill.',
      name: 'review',
      preferenceKey: 'root:root-a:review',
      sourceRootId: 'root-a',
      tier: 'root-brainstrike',
      userInvocable: false,
    });

    const shadowed = byStatus.get('shadowed');
    expect(shadowed).toMatchObject({
      name: 'review',
      preferenceKey: 'global:review',
      shadowedBy: { absPath: '/proj/a/.brainstrike/skills/review', tier: 'root-brainstrike' },
      tier: 'global-claude',
    });

    const invalid = byStatus.get('invalid');
    expect(invalid?.errors?.join('\n')).toMatch(/must match directory name "broken"/);
  });

  it('degrades to global-only scanning when the DB is unavailable', async () => {
    const result = await scanSkillsForRenderer({
      fs: makeFs(FS),
      getDatabase: () => Promise.reject(new Error('db down')),
      homedir: () => '/home/user',
    });
    const names = result.entries
      .filter((entry) => entry.status === 'ok')
      .map((entry) => entry.name);
    expect(names).toContain('review');
    expect(result.entries.every((entry) => entry.sourceRootId === undefined)).toBe(true);
  });
});
