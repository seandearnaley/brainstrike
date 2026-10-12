import { describe, expect, it } from 'vitest';
import {
  createScannedWorkspaceSkills,
  type SkillContentDeps,
} from '../skills/scanned-workspace-skills';
import { type SkillScanDeps, scanSkills } from '../skills/skill-scan';

interface MemoryFs {
  readonly dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  readonly files: Record<string, string>;
}

function makeDeps(fs: MemoryFs): SkillContentDeps & SkillScanDeps {
  const listDir: SkillScanDeps['listDir'] = (absDir, _containmentRoot, maxEntries) => {
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
  };
  const readFile = (absFile: string) =>
    absFile in fs.files
      ? ({ content: fs.files[absFile] as string, ok: true } as const)
      : ({ ok: false, reason: 'unreadable' } as const);
  return {
    listDir,
    readFile,
    readFileBytes: (absFile) => {
      const read = readFile(absFile);
      return read.ok
        ? { content: new TextEncoder().encode(read.content), ok: true }
        : { ok: false, reason: read.reason };
    },
    readFileText: readFile,
  };
}

function makeEngine(
  options: {
    allowedToolRule?: string;
    disabled?: boolean;
    shadowed?: boolean;
    launcher?: string;
  } = {}
) {
  const globalDir = '/home/user/.claude/skills/site-design';
  const rootDir = '/workspace/.brainstrike/skills/site-design';
  const winnerDir = options.shadowed ? rootDir : globalDir;
  const dirs: MemoryFs['dirs'] = {
    '/home/user/.claude/skills': [{ kind: 'dir', name: 'site-design' }],
    [globalDir]: [
      { kind: 'file', name: 'SKILL.md' },
      { kind: 'dir', name: 'scripts' },
    ],
    [`${globalDir}/scripts`]: [{ kind: 'file', name: 'palette.mjs' }],
  };
  const files: MemoryFs['files'] = {
    [`${globalDir}/SKILL.md`]: [
      '---',
      'name: site-design',
      'description: Design a website.',
      'allowed-tools:',
      `  - ${options.allowedToolRule ?? 'Bash(node .claude/skills/site-design/scripts/*)'}`,
      '---',
      'Use the palette helper.',
    ].join('\n'),
    [`${globalDir}/scripts/palette.mjs`]: 'console.log("palette")',
  };
  if (options.shadowed) {
    dirs['/workspace/.brainstrike/skills'] = [{ kind: 'dir', name: 'site-design' }];
    dirs[rootDir] = [
      { kind: 'file', name: 'SKILL.md' },
      { kind: 'dir', name: 'scripts' },
    ];
    dirs[`${rootDir}/scripts`] = [{ kind: 'file', name: 'palette.mjs' }];
    files[`${rootDir}/SKILL.md`] = [
      '---',
      'name: site-design',
      'description: Root-local website design.',
      'allowed-tools:',
      '  - Bash(node .brainstrike/skills/site-design/scripts/*)',
      '---',
      'Use the local palette helper.',
    ].join('\n');
    files[`${rootDir}/scripts/palette.mjs`] = 'console.log("local")';
  }
  if (options.launcher !== undefined) {
    dirs[`${winnerDir}/scripts`] = [
      ...(dirs[`${winnerDir}/scripts`] ?? []),
      { kind: 'file', name: 'impeccable' },
    ];
    files[`${winnerDir}/scripts/impeccable`] = options.launcher;
  }
  const fs = { dirs, files };
  const deps = makeDeps(fs);
  const engine = createScannedWorkspaceSkills({
    deps,
    ...(options.disabled ? { isEnabled: () => false } : {}),
    scan: () =>
      scanSkills(
        {
          homeDir: '/home/user',
          roots: [{ absPath: '/workspace', displayName: 'Workspace', id: 'root-a' }],
        },
        deps
      ),
  });
  return { engine, winnerDir };
}

describe('typed skill-script resolution', () => {
  it('resolves an allowed global Claude skill script without exposing a model-supplied absolute path', async () => {
    const { engine } = makeEngine();

    await expect(
      engine.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).resolves.toMatchObject({
      absolutePath: '/home/user/.claude/skills/site-design/scripts/palette.mjs',
      policy: 'matched-allowed-tools',
      scriptPath: 'scripts/palette.mjs',
      skillName: 'site-design',
      sourceTier: 'global-claude',
    });
  });

  // The 2026-10-12 debug pack's scripts/impeccable is a recorded #!/bin/sh launcher.
  it.each(['#!/bin/sh', '#!/usr/bin/env bash'])(
    'executes an extensionless shell launcher with the declared %s interpreter',
    async (header) => {
      const { engine } = makeEngine({
        allowedToolRule: 'Bash(bash .claude/skills/site-design/scripts/*)',
        launcher: `${header}\necho context`,
      });
      await expect(
        engine.resolveScriptExecution({
          runtime: 'bash',
          scriptPath: 'scripts/impeccable',
          skillName: 'site-design',
        })
      ).resolves.toMatchObject({
        policy: 'matched-allowed-tools',
        scriptPath: 'scripts/impeccable',
      });
      await expect(
        engine.resolveScriptExecution({
          runtime: 'node',
          scriptPath: 'scripts/impeccable',
          skillName: 'site-design',
        })
      ).rejects.toThrow(/runtime.*does not match/i);
    }
  );
  it.each([
    'echo no-interpreter',
    '#!/bin/zsh\necho wrong-interpreter',
    '#!/bin/sh -c\necho injected-option',
  ])(
    'rejects an extensionless launcher without a supported exact shebang: %s',
    async (launcher) => {
      const { engine } = makeEngine({ allowedToolRule: 'Bash(*)', launcher });
      await expect(
        engine.resolveScriptExecution({
          runtime: 'bash',
          scriptPath: 'scripts/impeccable',
          skillName: 'site-design',
        })
      ).rejects.toThrow(/runtime.*does not match/i);
    }
  );

  it('binds a workspace-local skill to its owning durable root', async () => {
    const { engine } = makeEngine({ shadowed: true });

    await expect(
      engine.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).resolves.toMatchObject({
      absolutePath: '/workspace/.brainstrike/skills/site-design/scripts/palette.mjs',
      sourceRootId: 'root-a',
      sourceTier: 'root-brainstrike',
    });
  });

  it.each([
    '/home/user/.claude/skills/site-design/scripts/palette.mjs',
    '../site-design/scripts/palette.mjs',
    'scripts/../SKILL.md',
    'palette.mjs',
  ])('rejects non-canonical script path %s', async (scriptPath) => {
    const { engine } = makeEngine();
    await expect(
      engine.resolveScriptExecution({ runtime: 'node', scriptPath, skillName: 'site-design' })
    ).rejects.toThrow(/skill-root-relative|scripts\//i);
  });

  it('rejects a runtime that does not match the bundled script extension', async () => {
    const { engine } = makeEngine();
    await expect(
      engine.resolveScriptExecution({
        runtime: 'python3',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/runtime.*does not match/i);
  });

  it('rejects a canonical but missing bundled script', async () => {
    const { engine } = makeEngine();
    await expect(
      engine.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/missing.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/missing/i);
  });

  it('rejects disabled skills and cannot address a shadowed skill by directory path', async () => {
    const disabled = makeEngine({ disabled: true }).engine;
    await expect(
      disabled.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/not available/i);

    const { engine } = makeEngine({ shadowed: true });
    await expect(
      engine.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: '/home/user/.claude/skills/site-design',
      })
    ).rejects.toThrow(/skill name/i);
  });

  it('fails closed when declared allowed-tools does not authorize the script runtime', async () => {
    const { engine } = makeEngine({ allowedToolRule: 'Bash(npx site-design *)' });
    await expect(
      engine.resolveScriptExecution({
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/allowed-tools|runtime/i);
  });

  it('does not let an exact no-argument allowed-tools rule authorize structured args', async () => {
    const { engine } = makeEngine({
      allowedToolRule: 'Bash(node .claude/skills/site-design/scripts/palette.mjs)',
    });
    await expect(
      engine.resolveScriptExecution({
        args: ['--target', 'src/index.html'],
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/allowed-tools/i);
  });

  it('preserves argv boundaries while matching allowed-tools arguments', async () => {
    const { engine } = makeEngine({
      allowedToolRule: 'Bash(node .claude/skills/site-design/scripts/palette.mjs --mode readonly)',
    });
    await expect(
      engine.resolveScriptExecution({
        args: ['--mode', 'readonly'],
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).resolves.toMatchObject({ policy: 'matched-allowed-tools' });
    await expect(
      engine.resolveScriptExecution({
        args: ['--mode readonly'],
        runtime: 'node',
        scriptPath: 'scripts/palette.mjs',
        skillName: 'site-design',
      })
    ).rejects.toThrow(/allowed-tools/i);
  });
});
