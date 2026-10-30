/**
 * The host's skills discovery (`workspace/skills`): entry → serializable
 * summary mapping (ok / invalid / shadowed, with durable preference keys and
 * exact validation errors) and explicit root-read failure propagation. ADR-0032:
 * the "/" menu and Settings list a folder's project skills and commands only
 * once the person trusts it, and `workspace/trust/list` says what each folder
 * would load.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillContentDeps } from '@brainstrike/agent';
import { __resetSkillScanWarningsForTests } from '@brainstrike/agent';
import {
  type HostWorkspaceTrustStore,
  writeHostWorkspaceTrust,
} from '@brainstrike/agent-host/workspace-trust';
import type { RuntimeWorkspaceRoot } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DesktopDiscoveryRoots,
  desktopWorkspaceDiscovery,
  discoverDesktopCommands,
  discoverDesktopSkills,
  discoverDesktopWorkspaceTrust,
} from '../agent-host-platform/desktop-workspace-discovery';

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

// The catalog resolves each root natively; the scanner then joins its tiers with
// `/` on every OS, so the in-memory tree is keyed exactly that way.
const PROJECT = path.resolve('/proj/a');
const HOME = path.resolve('/home/user');

const FS: MemoryFs = {
  dirs: {
    [`${HOME}/.claude/skills`]: [
      { kind: 'dir', name: 'review' },
      { kind: 'dir', name: 'broken' },
    ],
    [`${HOME}/.claude/skills/broken`]: [{ kind: 'file', name: 'SKILL.md' }],
    [`${HOME}/.claude/skills/review`]: [{ kind: 'file', name: 'SKILL.md' }],
    [`${PROJECT}/.brainstrike/skills`]: [{ kind: 'dir', name: 'review' }],
    [`${PROJECT}/.brainstrike/skills/review`]: [{ kind: 'file', name: 'SKILL.md' }],
  },
  files: {
    [`${HOME}/.claude/skills/broken/SKILL.md`]: '---\nname: not-broken\ndescription: Bad.\n---\nx',
    [`${HOME}/.claude/skills/review/SKILL.md`]:
      '---\nname: review\ndescription: Global review skill.\n---\nGlobal.',
    [`${PROJECT}/.brainstrike/skills/review/SKILL.md`]:
      '---\nname: review\ndescription: Root review skill.\nuser-invocable: false\n---\nRoot.',
  },
};

const ROOT_A: RuntimeWorkspaceRoot = { displayName: 'A', path: PROJECT, rootId: 'root-a' };

function scan(roots: DesktopDiscoveryRoots): ReturnType<typeof discoverDesktopSkills> {
  return discoverDesktopSkills(
    { fs: () => makeFs(FS), homedir: () => HOME, roots },
    new AbortController().signal
  );
}

beforeEach(() => {
  __resetSkillScanWarningsForTests();
});

describe('discoverDesktopSkills', () => {
  it('maps ok, shadowed, and invalid entries to serializable summaries', async () => {
    const result = await scan(async () => [ROOT_A]);

    const byStatus = new Map(result.entries.map((entry) => [entry.status, entry]));
    const ok = byStatus.get('ok');
    expect(ok).toMatchObject({
      absPath: `${PROJECT}/.brainstrike/skills/review`,
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
      shadowedBy: { absPath: `${PROJECT}/.brainstrike/skills/review`, tier: 'root-brainstrike' },
      tier: 'global-claude',
    });

    const invalid = byStatus.get('invalid');
    expect(invalid?.errors?.join('\n')).toMatch(/must match directory name "broken"/u);
  });

  it('rejects a root read failure instead of degrading to global-only scanning', async () => {
    const failure = new Error('Catalog unavailable');
    await expect(
      scan(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  it('scans global skills when no root is live', async () => {
    const result = await scan(async () => []);
    const names = result.entries
      .filter((entry) => entry.status === 'ok')
      .map((entry) => entry.name);
    expect(names).toContain('review');
    expect(result.entries.every((entry) => entry.sourceRootId === undefined)).toBe(true);
  });
});

describe('discoverDesktopCommands', () => {
  const commandFs = (disposed: { count: number }) => () => ({
    dispose: () => {
      disposed.count += 1;
    },
    listDir: (absDir: string) =>
      absDir === `${PROJECT}/.brainstrike/commands`
        ? {
            entries: [{ isDirectory: false, isFile: true, name: 'review.md' }],
            inspected: 1,
            truncated: false,
          }
        : null,
    readFile: (absFile: string) =>
      absFile === `${PROJECT}/.brainstrike/commands/review.md`
        ? { content: 'Review $ARGUMENTS', ok: true as const }
        : { ok: false as const, reason: 'unreadable' as const },
  });

  it('lists root commands with their root and closes the scan handle', async () => {
    const disposed = { count: 0 };
    const result = await discoverDesktopCommands(
      { fs: commandFs(disposed), homedir: () => HOME, roots: async () => [ROOT_A] },
      new AbortController().signal
    );
    expect(result.roots).toEqual([{ displayName: 'A', id: 'root-a' }]);
    expect(result.commands).toEqual([
      expect.objectContaining({
        id: 'review',
        sourceRootId: 'root-a',
        template: 'Review $ARGUMENTS',
      }),
    ]);
    expect(disposed.count).toBe(1);
  });

  it('rejects a root read failure without scanning', async () => {
    const failure = new Error('Catalog unavailable');
    const disposed = { count: 0 };
    await expect(
      discoverDesktopCommands(
        {
          fs: commandFs(disposed),
          homedir: () => HOME,
          roots: async () => {
            throw failure;
          },
        },
        new AbortController().signal
      )
    ).rejects.toBe(failure);
    expect(disposed.count).toBe(0);
  });
});

describe('workspace trust (ADR-0032)', () => {
  /** Commands and personas share one bounded reader: `dir -> { file -> content }`. */
  const MARKDOWN: Record<string, Record<string, string>> = {
    [`${PROJECT}/.brainstrike/agents`]: {
      'auditor.md': '---\ndescription: Audits security\n---\nAudit.',
    },
    [`${PROJECT}/.brainstrike/commands`]: { 'review.md': 'Review $ARGUMENTS' },
  };
  const markdownFs = () => ({
    dispose: () => undefined,
    listDir: (absDir: string) => {
      const files = MARKDOWN[absDir];
      return files
        ? {
            entries: Object.keys(files).map((name) => ({ isDirectory: false, isFile: true, name })),
            inspected: Object.keys(files).length,
            truncated: false,
          }
        : null;
    },
    readFile: (absFile: string) => {
      const content = MARKDOWN[path.posix.dirname(absFile)]?.[path.posix.basename(absFile)];
      return content === undefined
        ? { ok: false as const, reason: 'unreadable' as const }
        : { content, ok: true as const };
    },
  });
  function memoryTrust(): HostWorkspaceTrustStore {
    const values = new Map<string, string>();
    return {
      getSetting: async (key) => values.get(key),
      setSetting: async (key, value) => {
        values.set(key, value);
      },
    };
  }

  it('says what each live folder would load and the answer the person gave', async () => {
    // Trust is kept for folders that exist; B is a real, empty one.
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-trust-list-')));
    const rootB: RuntimeWorkspaceRoot = { displayName: 'B', path: folder, rootId: 'root-b' };
    const trust = memoryTrust();
    try {
      await writeHostWorkspaceTrust(trust, rootB.path, 'restricted');

      const result = await discoverDesktopWorkspaceTrust(
        {
          commands: markdownFs,
          homedir: () => HOME,
          readFile: async ({ rootPath, requestedPath }) => {
            if (rootPath === PROJECT && requestedPath === 'AGENTS.md') {
              return { content: 'Conventions', path: 'AGENTS.md', size: 11 };
            }
            throw Object.assign(new Error(`ENOENT: ${requestedPath}`), { code: 'ENOENT' });
          },
          roots: async () => [ROOT_A, rootB],
          skills: () => makeFs(FS),
          trust,
        },
        new AbortController().signal
      );

      // The home directory's skills and personas are nobody's folder.
      expect(result.roots).toEqual([
        {
          agentConfiguration: { commands: 1, instructions: 'AGENTS.md', personas: 1, skills: 1 },
          displayName: 'A',
          path: PROJECT,
          rootId: 'root-a',
          trust: 'undecided',
        },
        {
          agentConfiguration: { commands: 0, instructions: null, personas: 0, skills: 0 },
          displayName: 'B',
          path: folder,
          rootId: 'root-b',
          trust: 'restricted',
        },
      ]);
    } finally {
      await rm(folder, { force: true, recursive: true });
    }
  });

  it("lists a folder's project skills and commands only once the person trusts it", async () => {
    const project = await realpath(await mkdtemp(path.join(tmpdir(), 'bs-trust-discovery-')));
    // The production discovery reads the home directory too; give it an empty one.
    const home = path.join(project, 'home');
    await mkdir(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      await mkdir(path.join(project, '.brainstrike', 'skills', 'demo'), { recursive: true });
      await writeFile(
        path.join(project, '.brainstrike', 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: A cloned skill.\n---\nDemo.'
      );
      await mkdir(path.join(project, '.brainstrike', 'commands'), { recursive: true });
      await writeFile(path.join(project, '.brainstrike', 'commands', 'ship.md'), 'Ship it');
      const root: RuntimeWorkspaceRoot = { displayName: 'cloned', path: project, rootId: 'root-c' };
      const trust = memoryTrust();
      const discovery = desktopWorkspaceDiscovery(async () => [root], trust);
      const signal = new AbortController().signal;
      const fromProject = async () => ({
        commands: (await discovery.commands(signal)).commands
          .filter((command) => command.sourceRootId === 'root-c')
          .map((command) => command.id),
        skills: (await discovery.skills(signal)).entries
          .filter((entry) => entry.sourceRootId === 'root-c')
          .map((entry) => entry.name),
      });

      await expect(fromProject()).resolves.toEqual({ commands: [], skills: [] });
      await writeHostWorkspaceTrust(trust, project, 'restricted');
      await expect(fromProject()).resolves.toEqual({ commands: [], skills: [] });
      await writeHostWorkspaceTrust(trust, project, 'trusted');
      await expect(fromProject()).resolves.toEqual({ commands: ['ship'], skills: ['demo'] });
    } finally {
      vi.unstubAllEnvs();
      await rm(project, { force: true, recursive: true });
    }
  });
});
