/**
 * Real git + real PGlite coverage for per-repository worktree setup consent
 * (BST-1455): the repository/script identification surfaced to the create
 * sheet, and the renderer-attested decision pinned to main-resolved
 * repository identity.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createWorktreeService } from '../../assistant-server/worktree-service';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

describe('WorktreeService repository setup consent (real git + real PGlite)', () => {
  let db: PGlite;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    repo = workspace.freshRepo('repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('reports the repository and script path when repository setup needs consent', async () => {
    mkdirSync(path.join(repo, '.brainstrike'));
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), '#!/bin/sh\n');

    const context = await buildService().createContext({ rootId: 'r-1' });

    expect(context.ok).toBe(true);
    if (!context.ok) {
      return;
    }
    const repositoryPath = realpathSync(repo);
    const repositoryId = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    expect(context.value.repositorySetup).toEqual({
      repositoryId,
      repositoryPath,
      scriptPath: path.join(repositoryPath, '.brainstrike', 'worktree-setup.sh'),
    });
  });

  it('pins repository setup consent to main-resolved repository identity', async () => {
    const runSetup = vi.fn<Parameters<typeof createWorktreeService>[0]['runSetup']>(() =>
      Promise.resolve({
        copiedPaths: [],
        output: '',
        reason: null,
        skippedCopies: [],
        status: 'none' as const,
        truncated: false,
      })
    );
    const service = buildService({ runSetup });
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );

    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/mismatched-consent' },
      createdBy: 'user',
      name: 'mismatched-consent',
      repositorySetupDecision: {
        decision: 'approved',
        repositoryId: '/different/repository/.git',
      },
      rootId: 'r-1',
    });
    expect(runSetup.mock.calls[0]?.[0]).not.toHaveProperty('repositorySetupDecision');

    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/matched-consent' },
      createdBy: 'user',
      name: 'matched-consent',
      repositorySetupDecision: { decision: 'approved', repositoryId: commonDir },
      rootId: 'r-1',
    });
    expect(runSetup.mock.calls[1]?.[0]).toMatchObject({ repositorySetupDecision: 'approved' });
  });

  it.each([
    { label: 'disabled', setupCommand: 'disabled' as const },
    { label: 'configured argv', setupCommand: ['pnpm', 'install'] as const },
  ])('does not request repository-script consent for $label', async ({ setupCommand }) => {
    mkdirSync(path.join(repo, '.brainstrike'));
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), '#!/bin/sh\n');
    const context = await buildService({
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: true,
          managedDirectory,
          setupCommand,
        }),
    }).createContext({ rootId: 'r-1' });

    expect(context.ok && context.value.repositorySetup).toBeNull();
  });
});
