import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createActivePrFingerprint,
  findActivePrByFingerprint,
  fingerprintMarker,
} from '../agent-routines/shared/active-pr-dedupe.mjs';
import { createGitHubPrPublisher } from '../agent-routines/shared/github-pr.mjs';

const BASE_SHA = 'a'.repeat(40);
const FINGERPRINT = createActivePrFingerprint({
  candidate: { modelIds: ['vendor/model-a'] },
  routineId: 'model-catalog',
});

describe('scheduled-maintenance active PR deduplication', () => {
  it('creates stable fingerprints independent of object key order', () => {
    assert.equal(
      createActivePrFingerprint({ candidate: { a: 1, b: 2 }, routineId: 'routine' }),
      createActivePrFingerprint({
        candidate: Object.fromEntries([
          ['b', 2],
          ['a', 1],
        ]),
        routineId: 'routine',
      })
    );
  });

  it('matches an open PR by body marker or fingerprinted branch', async () => {
    const marker = fingerprintMarker(FINGERPRINT);
    const byBody = await findActivePrByFingerprint({
      fingerprint: FINGERPRINT,
      repository: 'owner/repo',
      runGh: async () => ({
        stdout: JSON.stringify([
          {
            body: `Evidence\n${marker}`,
            headRefName: 'automation/other',
            number: 7,
            url: 'https://example.test/7',
          },
        ]),
      }),
    });
    assert.equal(byBody.number, 7);

    const byBranch = await findActivePrByFingerprint({
      fingerprint: FINGERPRINT,
      repository: 'owner/repo',
      runGh: async () => ({
        stdout: JSON.stringify([
          {
            body: '',
            headRefName: `automation/model-${FINGERPRINT}`,
            number: 8,
            url: 'https://example.test/8',
          },
        ]),
      }),
    });
    assert.equal(byBranch.number, 8);
  });

  it('fails closed when open-PR state is unreadable', async () => {
    await assert.rejects(
      findActivePrByFingerprint({
        fingerprint: FINGERPRINT,
        repository: 'owner/repo',
        runGh: async () => ({ stdout: 'not-json' }),
      }),
      /GitHub PR state is unreadable/u
    );
  });
});

describe('scheduled-maintenance GitHub PR publisher', () => {
  it('refuses a duplicate active fingerprint without pushing', async () => {
    const gitCalls = [];
    const publisher = createGitHubPrPublisher({
      getCurrentBaseSha: async () => BASE_SHA,
      repository: 'owner/repo',
      runGh: async () => ({
        stdout: JSON.stringify([
          {
            body: fingerprintMarker(FINGERPRINT),
            headRefName: 'automation/existing',
            number: 9,
            url: 'https://example.test/9',
          },
        ]),
      }),
      runGit: async (call) => {
        gitCalls.push(call);
        return { stdout: '' };
      },
    });

    await assert.rejects(
      publisher.publish({
        baseSha: BASE_SHA,
        body: 'Evidence',
        branch: 'automation/model-fingerprint',
        cwd: '/tmp/worktree',
        fingerprint: FINGERPRINT,
        title: 'feat(models): add model',
      }),
      /active PR already exists/u
    );
    assert.deepEqual(gitCalls, []);
  });

  it('rejects a stale base and permits at most one PR', async () => {
    const stalePublisher = createGitHubPrPublisher({
      getCurrentBaseSha: async () => 'b'.repeat(40),
      repository: 'owner/repo',
      runGh: async () => ({ stdout: '[]' }),
      runGit: async () => ({ stdout: '' }),
    });
    await assert.rejects(
      stalePublisher.publish({
        baseSha: BASE_SHA,
        body: 'Evidence',
        branch: 'automation/model-fingerprint',
        cwd: '/tmp/worktree',
        fingerprint: FINGERPRINT,
        title: 'feat(models): add model',
      }),
      /stale frozen base/u
    );

    const ghCalls = [];
    const gitCalls = [];
    const publisher = createGitHubPrPublisher({
      getCurrentBaseSha: async () => BASE_SHA,
      repository: 'owner/repo',
      runGh: async (call) => {
        ghCalls.push(call);
        return {
          stdout: call.args[1] === 'list' ? '[]' : 'https://github.com/owner/repo/pull/10\n',
        };
      },
      runGit: async (call) => {
        gitCalls.push(call);
        return { stdout: '' };
      },
    });
    const proposal = {
      baseSha: BASE_SHA,
      body: 'Evidence',
      branch: 'automation/model-fingerprint',
      cwd: '/tmp/worktree',
      fingerprint: FINGERPRINT,
      title: 'feat(models): add model',
    };

    assert.equal(await publisher.publish(proposal), 'https://github.com/owner/repo/pull/10');
    assert.deepEqual(gitCalls[0], {
      args: ['push', 'origin', `HEAD:refs/heads/${proposal.branch}`],
      cwd: proposal.cwd,
    });
    const createCall = ghCalls.at(-1);
    assert.deepEqual(createCall.args.slice(0, 4), ['pr', 'create', '--repo', 'owner/repo']);
    assert.equal(createCall.args.includes('--head'), true);
    assert.equal(
      createCall.args
        .at(createCall.args.indexOf('--body') + 1)
        .includes(fingerprintMarker(FINGERPRINT)),
      true
    );

    await assert.rejects(() => publisher.publish(proposal), /one PR per run/u);
  });
});
