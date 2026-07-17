/**
 * Per-request skills engine resolution tests (desktop assistant server).
 *
 * `prepareRequestSkills` reads the renderer's `skillsPreference` (a PREFERENCE
 * that can only REDUCE the skill set — mirrors `subagentPersonasRequest`),
 * scans the four skills tiers over the mounted roots + home dir, and returns
 * the TRUSTED `workspaceSkills` engine for the agent runtime. Malformed
 * preferences are dropped with a warn and the fail-safe default applies
 * (master ON, nothing disabled). The built-in local provider never gets an
 * engine (its context budget cannot afford skill payloads).
 */

import type { RuntimeData, SkillScanDeps } from '@brainstrike/agent';
import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/utils';
import { describe, expect, it } from 'vitest';
import { prepareRequestSkills } from '../../assistant-server/request-skills';

interface MemoryFs {
  dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  files: Record<string, string>;
}

function makeScanDeps(fs: MemoryFs): SkillScanDeps {
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
    readFile: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

const FS: MemoryFs = {
  dirs: {
    '/home/user/.claude/skills': [{ kind: 'dir', name: 'global-skill' }],
    '/home/user/.claude/skills/global-skill': [{ kind: 'file', name: 'SKILL.md' }],
    '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'root-skill' }],
    '/proj/a/.brainstrike/skills/root-skill': [{ kind: 'file', name: 'SKILL.md' }],
  },
  files: {
    '/home/user/.claude/skills/global-skill/SKILL.md':
      '---\nname: global-skill\ndescription: A global skill.\n---\nGlobal body.',
    '/proj/a/.brainstrike/skills/root-skill/SKILL.md':
      '---\nname: root-skill\ndescription: A root skill.\n---\nRoot body.',
  },
};

function makeParams(runtimeData: Partial<RuntimeData> | undefined) {
  const scanDeps = makeScanDeps(FS);
  return {
    fs: {
      listDir: scanDeps.listDir,
      readFileBytes: () => ({ ok: false, reason: 'unreadable' }) as const,
      readFileText: scanDeps.readFile,
    },
    homedir: () => '/home/user',
    runtimeData: runtimeData as RuntimeData | undefined,
  };
}

const ROOTS = [{ displayName: 'A', path: '/proj/a', rootId: 'root-a' }];

function captureLogs(): { records: LogRecord[]; stop: () => void } {
  configureLogger({ console: false });
  const records: LogRecord[] = [];
  const stop = addLogListener((record) => records.push(record));
  return { records, stop };
}

describe('prepareRequestSkills', () => {
  it('builds an engine over roots + home tiers with the fail-safe default preference', async () => {
    const { workspaceSkills } = prepareRequestSkills(
      makeParams({ provider: 'openai', workspaceRoots: ROOTS })
    );
    expect(workspaceSkills).toBeDefined();
    const names = (await workspaceSkills?.list())?.map((skill) => skill.name).sort();
    expect(names).toEqual(['global-skill', 'root-skill']);
  });

  it('returns no engine when the master toggle is off', () => {
    const { workspaceSkills } = prepareRequestSkills(
      makeParams({
        provider: 'openai',
        skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
        workspaceRoots: ROOTS,
      })
    );
    expect(workspaceSkills).toBeUndefined();
  });

  it('filters skills disabled by their durable preference key', async () => {
    const { workspaceSkills } = prepareRequestSkills(
      makeParams({
        provider: 'openai',
        skillsPreference: {
          disabledSkillKeys: ['root:root-a:root-skill'],
          masterEnabled: true,
        },
        workspaceRoots: ROOTS,
      })
    );
    const names = (await workspaceSkills?.list())?.map((skill) => skill.name);
    expect(names).toEqual(['global-skill']);
  });

  it('returns no engine for the built-in local provider', () => {
    const { workspaceSkills } = prepareRequestSkills(
      makeParams({ provider: 'local', workspaceRoots: ROOTS })
    );
    expect(workspaceSkills).toBeUndefined();
  });

  it('drops a malformed preference with a warn and applies the fail-safe default', async () => {
    const { records, stop } = captureLogs();
    try {
      const { workspaceSkills } = prepareRequestSkills(
        makeParams({
          provider: 'openai',
          skillsPreference: {
            disabledSkillKeys: 'nope',
            masterEnabled: 'yes',
          } as unknown as RuntimeData['skillsPreference'],
          workspaceRoots: ROOTS,
        })
      );
      expect(workspaceSkills).toBeDefined();
      const names = (await workspaceSkills?.list())?.map((skill) => skill.name).sort();
      expect(names).toEqual(['global-skill', 'root-skill']);
      expect(
        records.some(
          (record) => record.level === 'warn' && /skills preference/i.test(String(record.message))
        )
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it('scans global tiers even when no workspace roots are mounted', async () => {
    const { workspaceSkills } = prepareRequestSkills(makeParams({ provider: 'openai' }));
    const names = (await workspaceSkills?.list())?.map((skill) => skill.name);
    expect(names).toEqual(['global-skill']);
  });
});
