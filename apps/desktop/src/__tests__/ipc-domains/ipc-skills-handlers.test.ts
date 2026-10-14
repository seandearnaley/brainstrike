/**
 * Skills scan IPC handler tests: entry → serializable summary mapping (ok /
 * invalid / shadowed, with durable preference keys and exact validation
 * errors) and explicit catalog-failure propagation.
 */

import type { SkillContentDeps } from '@brainstrike/agent';
import { __resetSkillScanWarningsForTests } from '@brainstrike/agent';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
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

const CATALOG_WITH_ROOT: WorkspaceRootPort = {
  workspaceRoots: async () => ({
    roots: [
      {
        createdAt: 1,
        displayName: 'A',
        id: 'root-a',
        kind: 'path',
        lastVerifiedAt: 1,
        path: '/proj/a',
        status: 'live',
      },
    ],
  }),
};

beforeEach(() => {
  __resetSkillScanWarningsForTests();
});

describe('scanSkillsForRenderer', () => {
  it('maps ok, shadowed, and invalid entries to serializable summaries', async () => {
    const result = await scanSkillsForRenderer({
      fs: makeFs(FS),
      homedir: () => '/home/user',
      workspaceRoots: CATALOG_WITH_ROOT,
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

  it('rejects catalog failure instead of degrading to global-only scanning', async () => {
    const failure = new Error('Catalog unavailable');
    await expect(
      scanSkillsForRenderer({
        fs: makeFs(FS),
        homedir: () => '/home/user',
        workspaceRoots: {
          workspaceRoots: async () => {
            throw failure;
          },
        },
      })
    ).rejects.toBe(failure);
  });

  it('scans global skills after an authoritative empty root catalog', async () => {
    const result = await scanSkillsForRenderer({
      fs: makeFs(FS),
      homedir: () => '/home/user',
      workspaceRoots: { workspaceRoots: async () => ({ roots: [] }) },
    });
    const names = result.entries
      .filter((entry) => entry.status === 'ok')
      .map((entry) => entry.name);
    expect(names).toContain('review');
    expect(result.entries.every((entry) => entry.sourceRootId === undefined)).toBe(true);
  });
});
