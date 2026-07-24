import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ResolvedSkillScriptExecution,
  RuntimeData,
  ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => fsPromises.rm(target, { force: true, recursive: true }))
  );
});

async function createFixture(): Promise<{
  resolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'>;
  rootA: string;
  rootB: string;
}> {
  const fixture = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-skill-run-'));
  cleanupPaths.push(fixture);
  const rootA = path.join(fixture, 'root-a');
  const rootB = path.join(fixture, 'root-b');
  const skillRoot = path.join(fixture, 'global-skill');
  const scriptsDir = path.join(skillRoot, 'scripts');
  await Promise.all([
    fsPromises.mkdir(path.join(rootA, 'site'), { recursive: true }),
    fsPromises.mkdir(rootB, { recursive: true }),
    fsPromises.mkdir(scriptsDir, { recursive: true }),
  ]);
  const absolutePath = path.join(scriptsDir, 'inspect.mjs');
  await fsPromises.writeFile(
    absolutePath,
    [
      'console.log(JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '}));',
    ].join('\n'),
    'utf8'
  );
  const resolved: ResolvedSkillScriptExecution = {
    absolutePath,
    policy: 'matched-allowed-tools',
    scriptPath: 'scripts/inspect.mjs',
    skillName: 'site-design',
    skillRootPath: skillRoot,
    sourceTier: 'global-claude',
  };
  return {
    resolver: {
      resolveScriptExecution: async () => resolved,
    },
    rootA,
    rootB,
  };
}

function runtime(rootA: string, rootB: string): RuntimeData {
  return {
    workspaceRoots: [
      { displayName: 'Site A', path: rootA, rootId: 'root-a' },
      { displayName: 'Site B', path: rootB, rootId: 'root-b' },
    ],
  } as RuntimeData;
}

describe('brainstrike.runSkillScript', () => {
  it('is registered only with a trusted skill resolver', async () => {
    const fixture = await createFixture();
    expect(buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB))).not.toHaveProperty(
      'brainstrike.runSkillScript'
    );
    expect(
      buildDesktopAssistantTools({
        ...runtime(fixture.rootA, fixture.rootB),
        enabledNativeToolIds: ['brainstrike.runSkillScript'],
      })
    ).not.toHaveProperty('brainstrike.runSkillScript');
    expect(
      buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
        skillScriptResolver: fixture.resolver,
      })
    ).toHaveProperty('brainstrike.runSkillScript');
  });

  it('runs a resolved script with literal argv in the explicitly mounted cwd', async () => {
    const fixture = await createFixture();
    const tool = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: fixture.resolver,
    })['brainstrike.runSkillScript'];
    const result = await tool.execute({
      args: ['--title', 'A site; touch should-not-run'],
      cwd: 'site',
      root: 'root-a',
      runtime: 'node',
      scriptPath: 'scripts/inspect.mjs',
      skillName: 'site-design',
    });
    expect(result).toMatchObject({
      exitCode: 0,
      policy: 'matched-allowed-tools',
      rootName: 'Site A',
      scriptPath: 'scripts/inspect.mjs',
      skillName: 'site-design',
      sourceTier: 'global-claude',
      timedOut: false,
      truncated: false,
      workingDirectory: 'site',
    });
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['--title', 'A site; touch should-not-run'],
      cwd: await fsPromises.realpath(path.join(fixture.rootA, 'site')),
    });
    await expect(fsPromises.access(path.join(fixture.rootA, 'should-not-run'))).rejects.toThrow();
  });

  it('rejects a workspace-local skill when the requested mounted root differs', async () => {
    const fixture = await createFixture();
    const localResolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> = {
      resolveScriptExecution: async (input) => ({
        ...(await fixture.resolver.resolveScriptExecution(input)),
        sourceRootId: 'root-a',
        sourceTier: 'root-brainstrike',
      }),
    };
    const tool = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: localResolver,
    })['brainstrike.runSkillScript'];
    await expect(
      tool.execute({
        cwd: '.',
        root: 'root-b',
        runtime: 'node',
        scriptPath: 'scripts/inspect.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/belongs to root id "root-a".*"root-b"/i);
  });

  it('rejects absolute and traversal working directories in the strict schema', async () => {
    const fixture = await createFixture();
    const tool = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: fixture.resolver,
    })['brainstrike.runSkillScript'];
    for (const cwd of ['/tmp', '../root-b']) {
      await expect(
        tool.execute({
          cwd,
          root: 'root-a',
          runtime: 'node',
          scriptPath: 'scripts/inspect.mjs',
          skillName: 'site-design',
        })
      ).rejects.toThrow(/root-relative path|canonical/i);
    }
  });
});
