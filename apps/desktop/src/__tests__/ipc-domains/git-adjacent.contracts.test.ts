import { CHANGES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/changes/availability';
import { FORGE_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/forge/availability';
import { WORKTREES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/worktrees/availability';
import { describe, expect, it } from 'vitest';
import { changesContract } from '../../ipc-domains/changes.contract';
import { forgeContract } from '../../ipc-domains/forge.contract';
import { worktreesContract } from '../../ipc-domains/worktrees.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

const CONTRACTS = [
  ['changes', changesContract, CHANGES_BRIDGE_REQUIRED_METHODS],
  ['forge', forgeContract, FORGE_BRIDGE_REQUIRED_METHODS],
  ['worktrees', worktreesContract, WORKTREES_BRIDGE_REQUIRED_METHODS],
] as const;

describe('Git-adjacent IPC contracts', () => {
  it.each(CONTRACTS)(
    '%s derives the exact renderer bridge key set',
    (_name, contract, required) => {
      expect(Object.keys(contract).sort()).toEqual([...required].sort());
    }
  );

  it.each(CONTRACTS)('%s keeps invokes raw and visible-UI-only', (_name, contract) => {
    for (const spec of Object.values(contract)) {
      if (spec.kind === 'push') {
        continue;
      }
      expect(spec).toMatchObject({ envelope: 'raw', roles: ['visible-ui'] });
    }
  });

  it('binds renamed bridge methods to their manifest channels', () => {
    expect(changesContract.onInvalidated.channel).toBe(DESKTOP_IPC_CHANNELS.changes.invalidated);
    expect(forgeContract.onPrUpdated.channel).toBe(DESKTOP_IPC_CHANNELS.forge.prUpdated);
    expect(worktreesContract.listManagedPaths.channel).toBe(
      DESKTOP_IPC_CHANNELS.worktrees.managedPaths
    );
  });

  it('classifies only the two main-to-renderer events as pushes', () => {
    expect(changesContract.onInvalidated.kind).toBe('push');
    expect(forgeContract.onPrUpdated.kind).toBe('push');
    expect(Object.values(worktreesContract).every((spec) => spec.kind === 'invoke')).toBe(true);
  });

  it('normalizes optional argument bags before handlers run', () => {
    expect(changesContract.inventory.parseArgs([])).toEqual([{}]);
    expect(changesContract.inventory.parseArgs([undefined])).toEqual([{}]);
    expect(changesContract.inventory.parseArgs([{ maxAgeMs: 0 }])).toEqual([{ maxAgeMs: 0 }]);
  });

  it('parses every Changes invoke into its handler tuple', () => {
    const changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' } as const;
    expect(changesContract.resolveView.parseArgs(['root-1', changeset])).toEqual([
      'root-1',
      changeset,
    ]);
    expect(changesContract.fileDiff.parseArgs(['root-1', changeset, 'src/index.ts'])).toEqual([
      'root-1',
      changeset,
      'src/index.ts',
    ]);
    // Host thread/rewind owns conversation branches; no dead legacy IPC remains.
    for (const removed of ['rewindPreview', 'applyRewind', 'redoRewind', 'finalizeRewinds']) {
      expect(Reflect.has(changesContract, removed)).toBe(false);
    }
  });

  it('parses every Forge invoke and keeps renderer-only refresh reasons', () => {
    expect(forgeContract.identity.parseArgs([' root-1 '])).toEqual([' root-1 ']);
    expect(forgeContract.prStatus.parseArgs(['root-1'])).toEqual(['root-1']);
    expect(forgeContract.refresh.parseArgs(['root-1', { reason: 'window' }])).toEqual([
      'root-1',
      { reason: 'window' },
    ]);
  });

  it('parses every Worktrees invoke and preserves optional-field omission', () => {
    const validCases = [
      [worktreesContract.adopt, [{ createdBy: 'user', path: '/repo/worktree' }]],
      [worktreesContract.archive, [{ worktreeId: 'worktree-1' }]],
      [worktreesContract.checkoutStatus, [{ path: '/repo/worktree' }]],
      [
        worktreesContract.create,
        [
          {
            baseRef: 'HEAD',
            branch: { detached: true },
            createdBy: 'agent',
            name: 'task',
            rootId: 'root-1',
          },
        ],
      ],
      [worktreesContract.createBranchHere, [{ branch: 'feature', worktreeId: 'worktree-1' }]],
      [worktreesContract.createContext, [{ rootId: 'root-1' }]],
      [worktreesContract.getSettings, []],
      [worktreesContract.inspectArchive, [{ worktreeId: 'worktree-1' }]],
      [worktreesContract.list, []],
      [worktreesContract.listManagedPaths, []],
      [worktreesContract.restore, [{ worktreeId: 'worktree-1' }]],
      [worktreesContract.setSettings, [{ managedDirectory: null, setupCommand: 'disabled' }]],
    ] as const;

    for (const [spec, args] of validCases) {
      expect(spec.parseArgs(args)).toEqual(args);
    }
    expect(
      worktreesContract.create.parseArgs([
        {
          baseRef: 'main',
          branch: { name: 'feature' },
          createdBy: 'user',
          name: 'feature',
          repositorySetupDecision: {
            decision: 'approved',
            repositoryId: 'repo-1',
            scriptSha256: 'sha-1',
          },
          rootId: 'root-1',
          runId: 'run-1',
          threadId: 'thread-1',
        },
      ])
    ).toEqual([
      {
        baseRef: 'main',
        branch: { name: 'feature' },
        createdBy: 'user',
        name: 'feature',
        repositorySetupDecision: {
          decision: 'approved',
          repositoryId: 'repo-1',
          scriptSha256: 'sha-1',
        },
        rootId: 'root-1',
        runId: 'run-1',
        threadId: 'thread-1',
      },
    ]);
  });

  it('rejects malformed renderer input before handler entry', () => {
    expect(() =>
      changesContract.fileDiff.parseArgs([
        'root-1',
        { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' },
        42,
      ])
    ).toThrow('changes fileDiff requires a string path');
    expect(() => forgeContract.refresh.parseArgs(['root-1', { reason: 'shell' }])).toThrow(
      'forge refresh reason must be "invalidation", "user", or "window"'
    );
    expect(() => worktreesContract.createBranchHere.parseArgs([{ branch: 42 }])).toThrow(
      'worktrees createBranchHere branch must be a string'
    );
  });

  it('rejects wrong argument counts and unsupported fields', () => {
    expect(() => changesContract.resolveView.parseArgs(['root-1'])).toThrow(
      'changes resolveView requires exactly 2 arguments'
    );
    expect(() => changesContract.inventory.parseArgs([{ surprise: true }])).toThrow(
      'changes inventory received unsupported fields: surprise'
    );
    expect(() =>
      forgeContract.refresh.parseArgs(['root-1', { reason: 'user', token: 'x' }])
    ).toThrow('forge refresh received unsupported fields: token');
    expect(() =>
      worktreesContract.archive.parseArgs([{ force: 'yes', worktreeId: 'worktree-1' }])
    ).toThrow('worktrees archive force must be a boolean when present');
    expect(() =>
      worktreesContract.setSettings.parseArgs([{ managedDirectory: null, setupCommand: [42] }])
    ).toThrow('worktrees setSettings setupCommand must be null, "disabled", or a string array');
    expect(() => worktreesContract.list.parseArgs(['unexpected'])).toThrow(
      'worktrees list requires exactly 0 arguments'
    );
  });

  it('leaves type-valid domain failures for raw-result handlers', () => {
    expect(changesContract.inventory.parseArgs([{ maxAgeMs: Number.NaN }])).toEqual([
      { maxAgeMs: Number.NaN },
    ]);
    expect(
      worktreesContract.createBranchHere.parseArgs([{ branch: '', worktreeId: 'worktree-1' }])
    ).toEqual([{ branch: '', worktreeId: 'worktree-1' }]);
    expect(
      worktreesContract.setSettings.parseArgs([{ managedDirectory: null, setupCommand: [] }])
    ).toEqual([{ managedDirectory: null, setupCommand: [] }]);
  });
});
