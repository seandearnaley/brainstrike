// @vitest-environment node

/**
 * ADR-0034: the host keeps a repository's setup script consent, so every
 * worktree it creates reads it, including one no person's create sheet asked
 * for (Automatic isolation, the model's worktree tool). Real git, a real
 * state store and the real setup runner.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorktreeSetup } from '../../src/git-workspace/worktree-setup.ts';
import { readWorktreeSetupConsent } from '../../src/git-workspace/worktree-setup-consent.ts';
import { createWorktreesMethods } from '../../src/git-workspace/worktrees-methods.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

const SCRIPT = 'echo ran > setup-ran.txt\n';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('worktree setup consent the host keeps (real git + real state store)', () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();

  function writeScript(script: string): void {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), script);
  }

  function host() {
    const service = buildTestService(
      { db, managedDirectory, repo },
      {
        readRepositorySetupConsent: (repositoryId) => readWorktreeSetupConsent(db, repositoryId),
        runSetup: runWorktreeSetup,
      }
    );
    const methods = createWorktreesMethods({
      readSettings: async () => ({
        isDefaultDirectory: true,
        managedDirectory,
        setupCommand: null,
      }),
      resolveService: () => service,
      setupConsentStore: db,
      writeSettings: async () => {
        throw new Error('Settings are not written here.');
      },
    });
    return { methods, service };
  }

  /** A worktree no person's create sheet asked for: it carries no answer of its own. */
  async function createAsTheHost(service: ReturnType<typeof host>['service'], name: string) {
    const created = await service.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'agent',
      name,
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    return created.value;
  }

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-setup-consent-state-'));
    repo = workspace.freshRepo('setup-consent');
    managedDirectory = workspace.freshManagedDir();
    writeScript(SCRIPT);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add the setup script']);
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('runs the setup script for a worktree the host makes once the repository is approved at the script’s hash', async () => {
    const { methods, service } = host();
    const decided = await methods.decideSetupConsent({
      decision: 'approved',
      rootId: 'r-1',
      scriptSha256: sha256(SCRIPT),
    });
    expect(decided).toMatchObject({ ok: true, value: { decision: 'approved' } });

    const { setup, worktree } = await createAsTheHost(service, 'approved');

    expect(setup).toMatchObject({ reason: null, status: 'succeeded' });
    expect(existsSync(path.join(worktree.path, 'setup-ran.txt'))).toBe(true);
    await expect(methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: { repositorySetup: { decision: 'approved', scriptSha256: sha256(SCRIPT) } },
    });
  });

  it('skips the script, saying consent is required, while the repository has no answer', async () => {
    const { methods, service } = host();

    const { setup, worktree } = await createAsTheHost(service, 'unanswered');

    expect(setup).toMatchObject({
      reason: 'Repository setup script consent is required before it can run.',
      status: 'skipped',
    });
    expect(existsSync(path.join(worktree.path, 'setup-ran.txt'))).toBe(false);
    await expect(methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: { repositorySetup: { decision: null } },
    });
  });

  it('skips the script when it changed since the repository was approved, and asks again', async () => {
    const { methods, service } = host();
    await methods.decideSetupConsent({
      decision: 'approved',
      rootId: 'r-1',
      scriptSha256: sha256(SCRIPT),
    });
    const edited = 'echo edited > setup-ran.txt\n';
    writeScript(edited);

    const { setup, worktree } = await createAsTheHost(service, 'edited');

    expect(setup).toMatchObject({
      reason: expect.stringContaining('the script changed since you last decided'),
      status: 'skipped',
    });
    expect(existsSync(path.join(worktree.path, 'setup-ran.txt'))).toBe(false);
    await expect(methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: { repositorySetup: { decision: null, scriptSha256: sha256(edited) } },
    });
  });

  it('records nothing for an answer given for other bytes than the script now holds', async () => {
    const { methods } = host();

    const decided = await methods.decideSetupConsent({
      decision: 'approved',
      rootId: 'r-1',
      scriptSha256: sha256('echo something else\n'),
    });

    expect(decided).toMatchObject({
      error: { code: 'worktree.setup-consent-refused' },
      ok: false,
    });
    await expect(methods.listSetupConsent()).resolves.toEqual({ ok: true, value: [] });
  });
});
