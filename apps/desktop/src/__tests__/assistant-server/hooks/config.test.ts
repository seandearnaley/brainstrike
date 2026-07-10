import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The raw-byte hash of the on-disk hooks file (the approve-time attestation). */
function approvedHash(rootAbsPath: string): string {
  const file = getProjectHooksPath(rootAbsPath);
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        { absPath: rootA, approvedSha256: approvedHash(rootA), rootId: 'root-a' },
        { absPath: rootB, approvedSha256: approvedHash(rootB), rootId: 'root-b' },
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        // No approval → untrusted.
        { absPath: rootA, rootId: 'root-a' },
        { absPath: rootB, approvedSha256: approvedHash(rootB), rootId: 'root-b' },
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [
        { absPath: rootA, approvedSha256: approvedHash(rootA), rootId: 'root-a' },
        { absPath: rootB, approvedSha256: approvedHash(rootB), rootId: 'root-b' },
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [{ absPath: rootA, approvedSha256: approvedHash(rootA), rootId: 'root-a' }],
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: rootA,
      roots: [{ absPath: rootA, approvedSha256: approvedHash(rootA), rootId: 'root-a' }],
    });

    expect(result.hooks.PreToolUse ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/timeout/i);
  });

  it('records no error for missing files and marks them exists:false', () => {
    const result = loadHooksConfig({
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [{ absPath: join(tmpRoot, 'a'), rootId: 'root-a' }],
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
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
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

  // M2: trust is resolved from the SAME single read that is parsed — the loaded
  // commands are provably the ones whose hash was trusted.
  describe('trust (single-read hash gate)', () => {
    it('loads a root only when its disk-byte hash matches the approval', () => {
      const rootA = join(tmpRoot, 'a');
      mkdirSync(rootA, { recursive: true });
      writeProjectHooks(rootA, JSON.stringify({ Stop: [{ command: 's', type: 'command' }] }));

      const result = loadHooksConfig({
        aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
        maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        primaryRootCwd: rootA,
        roots: [{ absPath: rootA, approvedSha256: approvedHash(rootA), rootId: 'root-a' }],
      });

      expect(result.errors).toEqual([]);
      expect(result.hooks.Stop?.map((h) => h.definition.command)).toEqual(['s']);
    });

    it('rejects a root whose file changed since approval (stale hash)', () => {
      const rootA = join(tmpRoot, 'a');
      mkdirSync(rootA, { recursive: true });
      writeProjectHooks(rootA, JSON.stringify({ Stop: [{ command: 's', type: 'command' }] }));
      const stale = createHash('sha256').update('{"old":true}').digest('hex');

      const result = loadHooksConfig({
        aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
        maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        primaryRootCwd: rootA,
        roots: [{ absPath: rootA, approvedSha256: stale, rootId: 'root-a' }],
      });

      expect(result.hooks.Stop ?? []).toHaveLength(0);
      expect(result.errors[0]?.message).toMatch(/untrusted/i);
    });

    it('does not cross-apply one root approval to a different root file', () => {
      const rootA = join(tmpRoot, 'a');
      const rootB = join(tmpRoot, 'b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      writeProjectHooks(rootA, JSON.stringify({ Stop: [{ command: 'a', type: 'command' }] }));
      writeProjectHooks(rootB, JSON.stringify({ Stop: [{ command: 'b', type: 'command' }] }));

      const result = loadHooksConfig({
        aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        globalPath: join(tmpRoot, 'no-global', 'hooks.json'),
        maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
        primaryRootCwd: rootA,
        // rootB carries rootA's hash → mismatch → untrusted.
        roots: [{ absPath: rootB, approvedSha256: approvedHash(rootA), rootId: 'root-b' }],
      });

      expect(result.hooks.Stop ?? []).toHaveLength(0);
      expect(result.errors[0]?.rootId).toBe('root-b');
    });
  });

  // I1: the PRE-STREAM UserPromptSubmit phase is aggregate-bounded; over-budget
  // config fails LOUD (phase disabled), never silently truncated.
  it('disables the UserPromptSubmit phase when its combined timeout hits the aggregate budget', () => {
    const globalDir = join(tmpRoot, 'home', '.brainstrike');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'hooks.json');
    writeFileSync(
      globalPath,
      JSON.stringify({
        UserPromptSubmit: [
          { command: 'a', timeout: 20_000, type: 'command' },
          { command: 'b', timeout: 20_000, type: 'command' },
          { command: 'c', timeout: 20_000, type: 'command' },
        ],
      }),
      'utf8'
    );

    const result = loadHooksConfig({
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [],
    });

    expect(result.hooks.UserPromptSubmit ?? []).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/aggregate budget/i);
  });

  it('keeps UserPromptSubmit hooks that stay under the aggregate budget', () => {
    const globalDir = join(tmpRoot, 'home', '.brainstrike');
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, 'hooks.json');
    writeFileSync(
      globalPath,
      JSON.stringify({
        UserPromptSubmit: [
          { command: 'a', timeout: 10_000, type: 'command' },
          { command: 'b', timeout: 10_000, type: 'command' },
        ],
      }),
      'utf8'
    );

    const result = loadHooksConfig({
      aggregateTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      globalPath,
      maxHookTimeoutMs: MAX_HOOK_TIMEOUT_MS,
      primaryRootCwd: tmpRoot,
      roots: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.hooks.UserPromptSubmit).toHaveLength(2);
  });
});
