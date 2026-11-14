// @vitest-environment node

/**
 * ADR-0034: the host keeps a repository's setup script consent, so every
 * worktree it creates reads it. Sean's decision of 2026-11-14 (BST-2501): the
 * person's approval runs the script for the worktrees they make, and for the
 * ones Brainstrike makes on its own (Automatic isolation, the model's
 * `manageWorktree`) only when they also chose that. Real git, a real state
 * store and the real setup runner.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostCheckoutIsolation } from '../../src/git-workspace/checkout-isolation.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { createGitService } from '../../src/git-workspace/git-service.ts';
import { runWorktreeSetup } from '../../src/git-workspace/worktree-setup.ts';
import { readWorktreeSetupConsent } from '../../src/git-workspace/worktree-setup-consent.ts';
import { hostWorktreeToolDependencies } from '../../src/git-workspace/worktree-tool-dependencies.ts';
import { createWorktreesMethods } from '../../src/git-workspace/worktrees-methods.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

const SCRIPT = 'echo ran > setup-ran.txt\n';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const BRAINSTRIKE_MADE_SKIP = expect.stringContaining('Brainstrike made this worktree on its own');
const signal = new AbortController().signal;

// The repository's script needs a POSIX shell; on Windows setup says so instead.
const itRuns = it.skipIf(process.platform === 'win32');

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
      listRepositoryWorktrees: async () => {
        throw new Error('Archived worktrees are not listed here.');
      },
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
    const services = {
      openWorktreeFolder: async (worktreePath: string) => ({
        displayName: path.basename(worktreePath),
        path: worktreePath,
        rootId: `root-${path.basename(worktreePath)}`,
      }),
      resolveWorktreeService: () => service,
    };
    const isolation = hostCheckoutIsolation({
      repository: () => createGitService({ cwd: repo, run: execFileGitRunner }).repository(),
      services,
      status: () => createGitService({ cwd: repo, run: execFileGitRunner }).status(),
    });
    const { worktreeTools } = hostWorktreeToolDependencies(services, {
      runId: 'run-1',
      threadId: 'thread-1',
    });
    if (!(isolation && worktreeTools)) {
      throw new Error('A host that opens worktrees as folders isolates and has worktree tools');
    }
    return { isolation, methods, service, worktreeTools };
  }

  type Host = ReturnType<typeof host>;

  function decide(
    methods: Host['methods'],
    answer: { readonly brainstrikeWorktrees: boolean; readonly decision: 'approved' | 'denied' },
    script = SCRIPT
  ) {
    return methods.decideSetupConsent({ ...answer, rootId: 'r-1', scriptSha256: sha256(script) });
  }

  /** A worktree the person makes from the where-control (the create sheet, New worktree…). */
  async function createAsThePerson({ service }: Host, name: string) {
    const created = await service.create({
      baseRef: 'main',
      branch: { name: `bs/${name}` },
      createdBy: 'user',
      name,
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    return { setup: created.value.setup, worktreePath: created.value.worktree.path };
  }

  /** Automatic isolation: a thread's first edit in a folder another thread's run is editing. */
  async function createByAutomaticIsolation({ isolation, service }: Host) {
    const entered = await isolation.create({
      rootId: 'r-1',
      runId: 'run-1',
      signal,
      threadId: 'thread-1',
    });
    if ('noWorktree' in entered) {
      throw new Error('A repository with a commit can be given a worktree');
    }
    // What the where-control shows for the thread's worktree: its ledger row's setup outcome.
    const listed = await service.list();
    const entry = listed.ok
      ? listed.value.find((candidate) => candidate.id === entered.worktreeId)
      : undefined;
    return {
      setup: { reason: entry?.setupReason, status: entry?.setupStatus },
      worktreePath: entered.root.path,
    };
  }

  /** The assistant's `manageWorktree` create. */
  async function createByManageWorktree({ worktreeTools }: Host, name: string) {
    const created = await worktreeTools.create({
      baseRef: 'main',
      branch: `bs/${name}`,
      name,
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    return { setup: created.value.setup, worktreePath: created.value.worktree.path };
  }

  function setupRan(worktreePath: string): boolean {
    return existsSync(path.join(worktreePath, 'setup-ran.txt'));
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

  itRuns('runs the script for a worktree the person makes on the approval alone', async () => {
    const brainstrike = host();
    await decide(brainstrike.methods, { brainstrikeWorktrees: false, decision: 'approved' });

    const { setup, worktreePath } = await createAsThePerson(brainstrike, 'mine');

    expect(setup).toMatchObject({ reason: null, status: 'succeeded' });
    expect(setupRan(worktreePath)).toBe(true);
    await expect(brainstrike.methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: {
        repositorySetup: {
          brainstrikeWorktrees: false,
          decision: 'approved',
          scriptSha256: sha256(SCRIPT),
        },
      },
    });
  });

  itRuns(
    'skips the script for an Automatic isolation worktree until the person also allows it for Brainstrike’s worktrees, and says why',
    async () => {
      const brainstrike = host();
      await decide(brainstrike.methods, { brainstrikeWorktrees: false, decision: 'approved' });

      const skipped = await createByAutomaticIsolation(brainstrike);

      expect(skipped.setup).toEqual({ reason: BRAINSTRIKE_MADE_SKIP, status: 'skipped' });
      expect(setupRan(skipped.worktreePath)).toBe(false);

      await decide(brainstrike.methods, { brainstrikeWorktrees: true, decision: 'approved' });
      const ran = await createByAutomaticIsolation(brainstrike);

      expect(ran.setup).toEqual({ reason: null, status: 'succeeded' });
      expect(setupRan(ran.worktreePath)).toBe(true);
    }
  );

  itRuns(
    'skips the script for a manageWorktree worktree until the person also allows it for Brainstrike’s worktrees, and tells the model why',
    async () => {
      const brainstrike = host();
      await decide(brainstrike.methods, { brainstrikeWorktrees: false, decision: 'approved' });

      const skipped = await createByManageWorktree(brainstrike, 'assistant-skipped');

      expect(skipped.setup).toMatchObject({ reason: BRAINSTRIKE_MADE_SKIP, status: 'skipped' });
      expect(setupRan(skipped.worktreePath)).toBe(false);

      await decide(brainstrike.methods, { brainstrikeWorktrees: true, decision: 'approved' });
      const ran = await createByManageWorktree(brainstrike, 'assistant-ran');

      expect(ran.setup).toMatchObject({ reason: null, status: 'succeeded' });
      expect(setupRan(ran.worktreePath)).toBe(true);
    }
  );

  it('skips the script, saying consent is required, while the repository has no answer', async () => {
    const brainstrike = host();

    const { setup, worktreePath } = await createByManageWorktree(brainstrike, 'unanswered');

    expect(setup).toMatchObject({
      reason: 'Repository setup script consent is required before it can run.',
      status: 'skipped',
    });
    expect(setupRan(worktreePath)).toBe(false);
    await expect(brainstrike.methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: { repositorySetup: { brainstrikeWorktrees: false, decision: null } },
    });
  });

  it('asks both answers again when the script changed since they were given', async () => {
    const brainstrike = host();
    await decide(brainstrike.methods, { brainstrikeWorktrees: true, decision: 'approved' });
    const edited = 'echo edited > setup-ran.txt\n';
    writeScript(edited);

    const assistant = await createByManageWorktree(brainstrike, 'edited-assistant');
    const mine = await createAsThePerson(brainstrike, 'edited-mine');

    for (const { setup, worktreePath } of [assistant, mine]) {
      expect(setup).toMatchObject({
        reason: expect.stringContaining('the script changed since you last decided'),
        status: 'skipped',
      });
      expect(setupRan(worktreePath)).toBe(false);
    }
    await expect(brainstrike.methods.createContext({ rootId: 'r-1' })).resolves.toMatchObject({
      ok: true,
      value: {
        repositorySetup: {
          brainstrikeWorktrees: false,
          decision: null,
          scriptSha256: sha256(edited),
        },
      },
    });
  });

  it('records nothing for an answer given for other bytes than the script now holds', async () => {
    const { methods } = host();

    const decided = await decide(
      methods,
      { brainstrikeWorktrees: false, decision: 'approved' },
      'echo something else\n'
    );

    expect(decided).toMatchObject({
      error: { code: 'worktree.setup-consent-refused' },
      ok: false,
    });
    await expect(methods.listSetupConsent()).resolves.toEqual({ ok: true, value: [] });
  });
});
