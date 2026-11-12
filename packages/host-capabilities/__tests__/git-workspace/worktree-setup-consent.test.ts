import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideWorktreeSetupConsent,
  listWorktreeSetupConsents,
  readWorktreeSetupConsent,
  revokeWorktreeSetupConsent,
  WORKTREE_SETUP_CONSENT_KEY,
  type WorktreeSetupConsentStore,
} from '../../src/git-workspace/worktree-setup-consent.ts';

/** The state store's settings, in memory. */
function memoryStore(): WorktreeSetupConsentStore & { readonly settings: Map<string, string> } {
  const settings = new Map<string, string>();
  return {
    deleteSetting: async (key) => settings.delete(key),
    getSetting: async (key) => settings.get(key),
    setSetting: async (key, value) => {
      settings.set(key, value);
    },
    settings,
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('worktree setup consent, the host record', () => {
  let directory: string;
  let store: ReturnType<typeof memoryStore>;

  /** A checkout whose `.brainstrike/worktree-setup.sh` holds `script`. */
  function checkout(name: string, script: string) {
    const repositoryRoot = path.join(directory, name);
    mkdirSync(path.join(repositoryRoot, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repositoryRoot, '.brainstrike', 'worktree-setup.sh'), script);
    return { commonDir: path.join(repositoryRoot, '.git'), repositoryRoot };
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'bst-setup-consent-'));
    store = memoryStore();
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it('records an answer for the script the person was shown, under the repository', async () => {
    const repository = checkout('app', 'echo setup\n');

    const decided = await decideWorktreeSetupConsent(store, {
      decision: 'approved',
      repository,
      scriptSha256: sha256('echo setup\n'),
    });

    expect(decided).toEqual({
      ok: true,
      value: {
        decidedAt: expect.any(String),
        decision: 'approved',
        repositoryId: repository.commonDir,
        scriptSha256: sha256('echo setup\n'),
      },
    });
    await expect(readWorktreeSetupConsent(store, repository.commonDir)).resolves.toEqual({
      decision: 'approved',
      scriptSha256: sha256('echo setup\n'),
    });
  });

  it('replaces the repository’s earlier answer when the person answers again', async () => {
    const repository = checkout('app', 'echo setup\n');
    const scriptSha256 = sha256('echo setup\n');
    await decideWorktreeSetupConsent(store, { decision: 'approved', repository, scriptSha256 });

    await decideWorktreeSetupConsent(store, { decision: 'denied', repository, scriptSha256 });

    await expect(listWorktreeSetupConsents(store)).resolves.toEqual([
      expect.objectContaining({ decision: 'denied', repositoryId: repository.commonDir }),
    ]);
  });

  it('refuses an answer for a script that changed since it was shown, and records nothing', async () => {
    const repository = checkout('app', 'echo edited\n');

    const decided = await decideWorktreeSetupConsent(store, {
      decision: 'approved',
      repository,
      scriptSha256: sha256('echo setup\n'),
    });

    expect(decided).toEqual({
      error: expect.objectContaining({
        code: 'worktree.setup-consent-refused',
        message: expect.stringContaining('changed since it was shown'),
      }),
      ok: false,
    });
    expect(store.settings.has(WORKTREE_SETUP_CONSENT_KEY)).toBe(false);
  });

  it('refuses an answer for a checkout that has no script', async () => {
    const repositoryRoot = path.join(directory, 'empty');
    mkdirSync(repositoryRoot);

    const decided = await decideWorktreeSetupConsent(store, {
      decision: 'approved',
      repository: { commonDir: path.join(repositoryRoot, '.git'), repositoryRoot },
      scriptSha256: sha256('echo setup\n'),
    });

    expect(decided.ok).toBe(false);
    expect(store.settings.has(WORKTREE_SETUP_CONSENT_KEY)).toBe(false);
  });

  it('lists every repository’s answer and revokes one, so its next worktree asks again', async () => {
    const app = checkout('app', 'echo app\n');
    const api = checkout('api', 'echo api\n');
    // Answered together: neither answer drops the other.
    await Promise.all([
      decideWorktreeSetupConsent(store, {
        decision: 'approved',
        repository: app,
        scriptSha256: sha256('echo app\n'),
      }),
      decideWorktreeSetupConsent(store, {
        decision: 'denied',
        repository: api,
        scriptSha256: sha256('echo api\n'),
      }),
    ]);
    await expect(listWorktreeSetupConsents(store)).resolves.toEqual([
      expect.objectContaining({ decision: 'denied', repositoryId: api.commonDir }),
      expect.objectContaining({ decision: 'approved', repositoryId: app.commonDir }),
    ]);

    await expect(revokeWorktreeSetupConsent(store, app.commonDir)).resolves.toBe(true);
    await expect(revokeWorktreeSetupConsent(store, app.commonDir)).resolves.toBe(false);

    await expect(readWorktreeSetupConsent(store, app.commonDir)).resolves.toBeUndefined();
    await expect(listWorktreeSetupConsents(store)).resolves.toEqual([
      expect.objectContaining({ repositoryId: api.commonDir }),
    ]);
  });

  it('fails a read of a record the host did not write rather than reading it as no answer', async () => {
    store.settings.set(WORKTREE_SETUP_CONSENT_KEY, JSON.stringify({ '/repo/.git': 'approved' }));

    await expect(readWorktreeSetupConsent(store, '/repo/.git')).rejects.toThrow();
  });
});
