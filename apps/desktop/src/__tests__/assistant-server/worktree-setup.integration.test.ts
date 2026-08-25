import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeSetupInput } from '../../assistant-server/worktree-service';
import {
  parseWorktreeInclude,
  runWorktreeSetup,
  WORKTREE_SETUP_OUTPUT_CAP_BYTES,
  worktreeSetupEnvironment,
} from '../../assistant-server/worktree-setup';

describe('parseWorktreeInclude', () => {
  it('keeps one pattern per line and drops comments and blanks', () => {
    expect(
      parseWorktreeInclude('.env\n\n# a comment\n  .env.local  \nconfig/*.local.json\n')
    ).toEqual(['.env', '.env.local', 'config/*.local.json']);
  });

  it('REJECTS an absolute or escaping pattern rather than copying outside the repo', () => {
    expect(() => parseWorktreeInclude('/etc/passwd\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "/etc/passwd"'
    );
    expect(() => parseWorktreeInclude('../secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "../secrets"'
    );
    expect(() => parseWorktreeInclude('..\\secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "..\\secrets"'
    );
    expect(() => parseWorktreeInclude('C:\\secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "C:\\secrets"'
    );
  });
});

describe('worktreeSetupEnvironment', () => {
  it('exports the Conductor-idiom BRAINSTRIKE_* variables', () => {
    const env = worktreeSetupEnvironment({
      rootPath: '/work/app',
      worktreeName: 'bright-fox',
      worktreePath: '/managed/app/bright-fox',
    });
    expect(env).toMatchObject({
      BRAINSTRIKE_ROOT_PATH: '/work/app',
      BRAINSTRIKE_WORKSPACE_NAME: 'bright-fox',
      BRAINSTRIKE_WORKSPACE_PATH: '/managed/app/bright-fox',
    });
    expect(Number.parseInt(env['BRAINSTRIKE_PORT'] as string, 10)).toBeGreaterThanOrEqual(3000);
  });

  it('derives a STABLE port from the worktree path', () => {
    const once = worktreeSetupEnvironment({
      rootPath: '/r',
      worktreeName: 'a',
      worktreePath: '/m/a',
    });
    const twice = worktreeSetupEnvironment({
      rootPath: '/r',
      worktreeName: 'a',
      worktreePath: '/m/a',
    });
    expect(once['BRAINSTRIKE_PORT']).toBe(twice['BRAINSTRIKE_PORT']);
  });
});

describe('runWorktreeSetup (real fs + real processes)', () => {
  let repo: string;
  let tempRoot: string;
  let worktreePath: string;

  function baseInput(): WorktreeSetupInput {
    return {
      settings: {
        isDefaultDirectory: true,
        managedDirectory: tempRoot,
        setupCommand: null,
      },
      sourcePath: repo,
      worktree: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: 'main',
        branch: 'bs/bright-fox',
        createdAt: '2026-08-25T00:00:00.000Z',
        createdBy: 'user',
        id: '01993a12-0000-7000-8000-000000000013',
        path: worktreePath,
        repoCommonDir: path.join(repo, '.git'),
        runId: null,
        setupOutput: null,
        setupStatus: 'none',
        threadId: null,
      },
    };
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'brainstrike-worktree-setup-'));
    repo = path.join(tempRoot, 'repo');
    worktreePath = path.join(tempRoot, 'bright-fox');
    mkdirSync(repo);
    mkdirSync(worktreePath);
  });

  afterEach(() => {
    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('reports "none" when there is nothing to copy and nothing to run', async () => {
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome).toEqual({
      copiedPaths: [],
      output: '',
      reason: null,
      status: 'none',
      truncated: false,
    });
  });

  it('copies files matched by .worktreeinclude, ignored ones included', async () => {
    writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.copiedPaths).toEqual(['.env']);
    expect(readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(outcome.status).toBe('succeeded');
  });

  it('runs .brainstrike/worktree-setup.sh with the BRAINSTRIKE_* env and captures its output', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\necho "name=$BRAINSTRIKE_WORKSPACE_NAME"\n'
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).toContain('name=bright-fox');
  });

  it('reports a FAILING script as failed WITH its output, and does not throw', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\necho "boom" >&2\nexit 3\n'
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('Setup command exited with code 3.');
    expect(outcome.output).toContain('boom');
  });

  it('prefers an explicit settings setupCommand over the repository script', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), '#!/bin/sh\necho script\n');
    const input = baseInput();
    const outcome = await runWorktreeSetup({
      ...input,
      settings: { ...input.settings, setupCommand: ['echo', 'configured'] },
    });
    expect(outcome.output).toContain('configured');
    expect(outcome.output).not.toContain('script');
  });

  it('truncates oversized output and SAYS it truncated', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\nfor i in $(seq 1 4000); do echo "0123456789"; done\n'
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(
      WORKTREE_SETUP_OUTPUT_CAP_BYTES
    );
  });
});
