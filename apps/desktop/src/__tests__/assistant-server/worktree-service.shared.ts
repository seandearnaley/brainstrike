import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { WorktreeLedgerDatabase } from '../../assistant-server/worktree-ledger';
import { createWorktreeService } from '../../assistant-server/worktree-service';
import { execFileGitRunner } from '../../git-ipc-handlers';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function createTestWorkspace() {
  const tempDirs: string[] = [];

  function freshTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function freshRepo(label: string): string {
    const dir = freshTempDir(`bst-wt-${label}-`);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@brainstrike.invalid']);
    git(dir, ['config', 'user.name', 'BrainStrike Test']);
    writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial commit']);
    return dir;
  }

  function freshManagedDir(): string {
    return freshTempDir('bst-managed-');
  }

  function cleanup(): void {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  }

  return { cleanup, freshManagedDir, freshRepo, freshTempDir };
}

export function asLedgerDatabase(database: PGlite): WorktreeLedgerDatabase {
  return {
    async query(sql, params) {
      const result = await database.query(sql, params);
      return { rows: result.rows };
    },
  };
}

export function buildTestService(
  ctx: { readonly db: PGlite; readonly managedDirectory: string; readonly repo: string },
  overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}
) {
  return createWorktreeService({
    getDatabase: () => Promise.resolve(asLedgerDatabase(ctx.db)),
    readSettings: () =>
      Promise.resolve({
        isDefaultDirectory: true,
        managedDirectory: ctx.managedDirectory,
        setupCommand: null,
      }),
    recordRunEvent: () => Promise.resolve(),
    resolveInventory: () => Promise.resolve({ errors: [], repositories: [] }),
    resolveRootCwd: (rootId: string) =>
      Promise.resolve(
        rootId === 'r-1'
          ? { ok: true as const, value: ctx.repo }
          : { error: 'unknown root', ok: false as const }
      ),
    resolveRootPaths: () => Promise.resolve([{ id: 'r-1', path: ctx.repo }]),
    run: execFileGitRunner,
    runSetup: () =>
      Promise.resolve({
        copiedPaths: [],
        output: '',
        reason: null,
        skippedCopies: [],
        status: 'none' as const,
        truncated: false,
      }),
    ...overrides,
  });
}
