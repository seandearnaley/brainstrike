import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGlobalHooksPath,
  getProjectHooksPath,
  loadHooksConfig,
} from '../../../assistant-server/hooks/config';

const MAX_HOOK_TIMEOUT_MS = 60_000;

let tmpRoot: string;

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeProjectHooks(rootAbsPath: string, content: string): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

beforeEach(() => {
  tmpRoot = makeDir('bs-hooks-config-');
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('getProjectHooksPath / getGlobalHooksPath', () => {
  it('resolves the project hooks path under <root>/.brainstrike/hooks.json', () => {
    expect(getProjectHooksPath('/abs/root')).toBe('/abs/root/.brainstrike/hooks.json');
  });

  it('resolves the global hooks path under the home .brainstrike dotfile', () => {
    expect(getGlobalHooksPath().endsWith('/.brainstrike/hooks.json')).toBe(true);
  });
});

describe('loadHooksConfig', () => {
  it('loads global-only hooks when there are no roots', () => {
    const globalDir = join(tmpRoot, 'home', '.brainstrike');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'hooks.json');
    writeFileSync(
      globalPath,
      JSON.stringify({
        PreToolUse: [{ command: 'echo hi', type: 'command' }],
      }),
      'utf8'
    );

    const result = loadHooksConfig({
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.hooks.PreToolUse).toHaveLength(1);
    expect(result.hooks.PreToolUse?.[0]?.source.scope).toBe('global');
    expect(result.hooks.PreToolUse?.[0]?.source.cwd).toBe(tmpRoot);
  });

  it('merges global then roots in order and tags per-hook cwd/rootId', () => {
    const globalDir = join(tmpRoot, 'home', '.brainstrike');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'hooks.json');
    writeFileSync(
      globalPath,
      JSON.stringify({ PreToolUse: [{ command: 'global', type: 'command' }] }),
      'utf8'
    );

    const rootA = join(tmpRoot, 'a');
    const rootB = join(tmpRoot, 'b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeProjectHooks(rootA, JSON.stringify({ PreToolUse: [{ command: 'a', type: 'command' }] }));
    writeProjectHooks(rootB, JSON.stringify({ PreToolUse: [{ command: 'b', type: 'command' }] }));

    const result = loadHooksConfig({
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        { absPath: rootA, rootId: 'root-a', trusted: true },
        { absPath: rootB, rootId: 'root-b', trusted: true },
      ],
    });

    expect(result.errors).toEqual([]);
    const commands = result.hooks.PreToolUse?.map((h) => h.definition.command);
    expect(commands).toEqual(['global', 'a', 'b']);
    const projectHooks = result.hooks.PreToolUse?.filter((h) => h.source.scope === 'project') ?? [];
    expect(projectHooks[0]?.source.rootId).toBe('root-a');
    expect(projectHooks[0]?.source.cwd).toBe(rootA);
    expect(projectHooks[1]?.source.rootId).toBe('root-b');
  });

  it('skips an untrusted project root with an error entry but loads the trusted ones', () => {
    const rootA = join(tmpRoot, 'a');
    const rootB = join(tmpRoot, 'b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeProjectHooks(rootA, JSON.stringify({ PreToolUse: [{ command: 'a', type: 'command' }] }));
    writeProjectHooks(rootB, JSON.stringify({ PreToolUse: [{ command: 'b', type: 'command' }] }));

    const result = loadHooksConfig({
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        { absPath: rootA, rootId: 'root-a', trusted: false },
        { absPath: rootB, rootId: 'root-b', trusted: true },
      ],
    });

    const commands = result.hooks.PreToolUse?.map((h) => h.definition.command);
    expect(commands).toEqual(['b']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rootId).toBe('root-a');
    expect(result.errors[0]?.message).toMatch(/untrusted/i);
  });

  it('disables a file with invalid JSON but keeps other files', () => {
    const rootA = join(tmpRoot, 'a');
    const rootB = join(tmpRoot, 'b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeProjectHooks(rootA, '{ not valid json');
    writeProjectHooks(rootB, JSON.stringify({ PreToolUse: [{ command: 'b', type: 'command' }] }));

    const result = loadHooksConfig({
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        { absPath: rootA, rootId: 'root-a', trusted: true },
        { absPath: rootB, rootId: 'root-b', trusted: true },
      ],
    });

    expect(result.hooks.PreToolUse?.map((h) => h.definition.command)).toEqual(['b']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rootId).toBe('root-a');
  });

  it('disables a file whose matcher regex cannot compile', () => {
    const rootA = join(tmpRoot, 'a');
    mkdirSync(rootA, { recursive: true });
    writeProjectHooks(
      rootA,
      JSON.stringify({
        PreToolUse: [{ command: 'x', matcher: { tool_name: '([' }, type: 'command' }],
      })
    );

    const result = loadHooksConfig({
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [{ absPath: rootA, rootId: 'root-a', trusted: true }],
    });

    expect(result.hooks.PreToolUse ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });

  it('disables a file whose hook timeout is >= maxHookTimeoutMs', () => {
    const rootA = join(tmpRoot, 'a');
    mkdirSync(rootA, { recursive: true });
    writeProjectHooks(
      rootA,
      JSON.stringify({
        PreToolUse: [{ command: 'x', timeout: MAX_HOOK_TIMEOUT_MS, type: 'command' }],
      })
    );

    const result = loadHooksConfig({
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [{ absPath: rootA, rootId: 'root-a', trusted: true }],
    });

    expect(result.hooks.PreToolUse ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/timeout/i);
  });

  it('records no error for missing files and marks them exists:false', () => {
    const result = loadHooksConfig({
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [{ absPath: join(tmpRoot, 'a'), rootId: 'root-a', trusted: true }],
    });

    expect(result.errors).toEqual([]);
    expect(result.hooks.PreToolUse ?? []).toHaveLength(0);
    expect(result.sources.every((s) => s.exists === false)).toBe(true);
  });

  it('precompiles the tool_name matcher into a RegExp', () => {
    const globalDir = join(tmpRoot, 'home', '.brainstrike');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'hooks.json');
    writeFileSync(
      globalPath,
      JSON.stringify({
        PreToolUse: [{ command: 'x', matcher: { tool_name: '^exec' }, type: 'command' }],
      }),
      'utf8'
    );

    const result = loadHooksConfig({
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [],
    });

    const regex = result.hooks.PreToolUse?.[0]?.toolNameRegex;
    expect(regex).toBeInstanceOf(RegExp);
    expect(regex?.test('executeCommand')).toBe(true);
    expect(regex?.test('readFile')).toBe(false);
  });
});
