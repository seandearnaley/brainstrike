import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  type ResolvedSkillScriptExecution,
  type RuntimeData,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { requireToolExecute } from './_tool-test-helpers';

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
  scriptsDir: string;
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
    scriptsDir,
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
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    const result = await executeTool({
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

  it('fits escape-heavy output to the serialized native result budget', async () => {
    // PR #2338 review: the previous raw-length fit let quote-heavy stdout (a
    // script printing JSON) serialize past NATIVE_TOOL_RESULT_CHAR_BUDGET,
    // violating the self-bound the model projection enforces.
    const fixture = await createFixture();
    const noisyPath = path.join(fixture.scriptsDir, 'noisy.mjs');
    await fsPromises.writeFile(
      noisyPath,
      [
        'const line = JSON.stringify({ event: "case-finished", level: "info", status: "passed" });',
        'for (let index = 0; index < 400; index += 1) { console.log(line); }',
      ].join('\n'),
      'utf8'
    );
    const noisyResolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> = {
      resolveScriptExecution: async (input) => ({
        ...(await fixture.resolver.resolveScriptExecution(input)),
        absolutePath: noisyPath,
        scriptPath: 'scripts/noisy.mjs',
      }),
    };
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: noisyResolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    const result = await executeTool({
      cwd: '.',
      root: 'root-a',
      runtime: 'node',
      scriptPath: 'scripts/noisy.mjs',
      skillName: 'site-design',
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(NATIVE_TOOL_RESULT_CHAR_BUDGET);
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
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: localResolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await expect(
      executeTool({
        cwd: '.',
        root: 'root-b',
        runtime: 'node',
        scriptPath: 'scripts/inspect.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/belongs to root id "root-a".*"root-b"/i);
  });

  it('rejects a script that symlinks outside its skill root', async () => {
    // BST-1256 review: pins the `escapes skill` guard at the site level — a
    // user-authored skill must not run code smuggled out of its own directory
    // via a symlinked script entry. The guard realpaths both sides, so the
    // symlink resolves outside the skill root and must reject.
    const fixture = await createFixture();
    const outsideScript = path.join(path.dirname(fixture.scriptsDir), '..', 'smuggled.mjs');
    await fsPromises.writeFile(outsideScript, 'console.log("should never run");\n', 'utf8');
    const symlinkPath = path.join(fixture.scriptsDir, 'escape.mjs');
    await fsPromises.symlink(outsideScript, symlinkPath);
    const escapingResolver: Pick<ScannedWorkspaceSkills, 'resolveScriptExecution'> = {
      resolveScriptExecution: async (input) => ({
        ...(await fixture.resolver.resolveScriptExecution(input)),
        absolutePath: symlinkPath,
        scriptPath: 'scripts/escape.mjs',
      }),
    };
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: escapingResolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await expect(
      executeTool({
        cwd: '.',
        root: 'root-a',
        runtime: 'node',
        scriptPath: 'scripts/escape.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/escapes skill/);
  });

  it('runs the python3 runtime through the injected bundled-Python resolver', async () => {
    const fixture = await createFixture();
    // The running Node executable stands in for the interpreter and prints
    // its script argv, proving execution uses the resolver rather than PATH python3.
    await fsPromises.writeFile(
      path.join(fixture.scriptsDir, 'inspect.mjs'),
      'console.log(process.argv[1]);',
      'utf8'
    );
    const resolvePythonExecutable = async () => process.execPath;
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      resolvePythonExecutable,
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    const result = await executeTool({
      cwd: '.',
      root: 'root-a',
      runtime: 'python3',
      scriptPath: 'scripts/inspect.mjs',
      skillName: 'site-design',
    });
    expect(result).toMatchObject({ exitCode: 0, runtime: 'python3', timedOut: false });
    expect(result.stdout.trim()).toContain(path.join('scripts', 'inspect.mjs'));
  });

  it('propagates a typed bundled-Python failure instead of falling back to PATH python3', async () => {
    const fixture = await createFixture();
    const failure = Object.assign(
      new Error('The bundled Python runtime does not support linux/x64'),
      {
        code: 'python_unsupported_platform',
      }
    );
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      resolvePythonExecutable: () => Promise.reject(failure),
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await expect(
      executeTool({
        cwd: '.',
        root: 'root-a',
        runtime: 'python3',
        scriptPath: 'scripts/inspect.mjs',
        skillName: 'site-design',
      })
    ).rejects.toBe(failure);
  });

  it('bounds a slow bundled-Python resolve by the tool timeout budget', async () => {
    // PR #2205 review: a cold first-run unpack used to run before `startedAt`
    // and outside `timeoutMs`. This pins the fix — a resolver that never
    // settles on its own must be aborted by the tool's own budget, and the
    // script must not run.
    const fixture = await createFixture();
    const resolvePythonExecutable = (signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      resolvePythonExecutable,
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    const startedAt = Date.now();
    await expect(
      executeTool({
        cwd: '.',
        root: 'root-a',
        runtime: 'python3',
        scriptPath: 'scripts/inspect.mjs',
        skillName: 'site-design',
        timeoutMs: 500,
      })
    ).rejects.toThrow(/timeout|timed out|abort/i);
    // Loose upper bound only — proves the budget fired rather than the
    // resolver hanging forever; deliberately not a tight wall-clock assert.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('names preparation expiry when runtime resolution returns after its deadline', async () => {
    const fixture = await createFixture();
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      resolvePythonExecutable: (signal) =>
        new Promise<string>((resolve) => {
          if (!signal) {
            throw new Error('Missing runtime preparation deadline');
          }
          signal.addEventListener('abort', () => resolve(process.execPath), { once: true });
        }),
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    await expect(
      executeTool({
        cwd: '.',
        root: 'root-a',
        runtime: 'python3',
        scriptPath: 'scripts/inspect.mjs',
        skillName: 'site-design',
        timeoutMs: 20,
      })
    ).rejects.toThrow(
      'Preparing the "python3" skill-script runtime and workspace ownership exceeded the 20ms timeout; the script was not run.'
    );
  });

  it('rejects absolute and traversal working directories in the strict schema', async () => {
    const fixture = await createFixture();
    const tools = buildDesktopAssistantTools(runtime(fixture.rootA, fixture.rootB), {
      skillScriptResolver: fixture.resolver,
    });
    const executeTool = requireToolExecute(tools, 'brainstrike.runSkillScript');
    for (const cwd of ['/tmp', '../root-b']) {
      await expect(
        executeTool({
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
