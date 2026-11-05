import type { FileExplorerState, StoredRootDescriptor } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActiveRootActions } from '../active-root-actions';

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: loggerWarn,
  }),
}));

const ROOT_A: StoredRootDescriptor = {
  displayName: 'ProjectA',
  path: '/Users/me/ProjectA',
  rootId: 'root-a',
};
const ROOT_B: StoredRootDescriptor = {
  displayName: 'ProjectB',
  path: '/Users/me/ProjectB',
  rootId: 'root-b',
};
const ROOT_C: StoredRootDescriptor = {
  displayName: 'ProjectC',
  path: '/Users/me/ProjectC',
  rootId: 'root-c',
};

/**
 * Minimal harness: applies functional/object setState updates against a plain
 * state object so the tests observe exactly what the action wrote.
 */
function makeHarness(initial: Partial<FileExplorerState>) {
  let state = {
    activeRootIds: [],
    folderAccessOrder: [],
    folderStates: {},
    rootDescriptors: {},
    ...initial,
  } as FileExplorerState;
  const set = (
    partial:
      | Partial<FileExplorerState>
      | ((current: FileExplorerState) => Partial<FileExplorerState>)
  ) => {
    const update = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...update };
  };
  const get = () => state;
  const actions = createActiveRootActions(
    set as Parameters<typeof createActiveRootActions>[0],
    get as Parameters<typeof createActiveRootActions>[1]
  );
  return { actions, getState: get };
}

describe('setMainRoot (main root = activeRootIds[0])', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('moves the given rootId to the FRONT preserving the relative order of the rest', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId, ROOT_C.rootId],
      rootDescriptors: {
        [ROOT_A.rootId]: ROOT_A,
        [ROOT_B.rootId]: ROOT_B,
        [ROOT_C.rootId]: ROOT_C,
      },
    });

    actions.setMainRoot(ROOT_C.rootId);

    expect(getState().activeRootIds).toEqual([ROOT_C.rootId, ROOT_A.rootId, ROOT_B.rootId]);
  });

  it('is a no-op (state identity preserved) when the rootId is already the main root', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId],
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });
    const before = getState().activeRootIds;

    actions.setMainRoot(ROOT_A.rootId);

    expect(getState().activeRootIds).toBe(before);
  });

  it('is a warn-and-no-op for an unknown rootId (never invents an entry)', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId],
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });

    actions.setMainRoot('nope');

    expect(getState().activeRootIds).toEqual([ROOT_A.rootId, ROOT_B.rootId]);
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('does NOT touch rootDescriptors or folderStates', () => {
    const folderStates = {} as FileExplorerState['folderStates'];
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId],
      folderStates,
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });
    const descriptorsBefore = getState().rootDescriptors;

    actions.setMainRoot(ROOT_B.rootId);

    expect(getState().rootDescriptors).toBe(descriptorsBefore);
    expect(getState().folderStates).toBe(folderStates);
  });
});

describe('removeActiveRoot main-promotion (pins existing behavior)', () => {
  it('removing the main root promotes the next id to activeRootIds[0]', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId, ROOT_C.rootId],
      rootDescriptors: {
        [ROOT_A.rootId]: ROOT_A,
        [ROOT_B.rootId]: ROOT_B,
        [ROOT_C.rootId]: ROOT_C,
      },
    });

    actions.removeActiveRoot(ROOT_A.rootId);

    expect(getState().activeRootIds).toEqual([ROOT_B.rootId, ROOT_C.rootId]);
  });

  it('re-adding a previously removed root appends it to the END (demoted, recoverable)', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_A.rootId, ROOT_B.rootId],
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });

    actions.removeActiveRoot(ROOT_A.rootId);
    actions.addActiveRoot(ROOT_A);

    expect(getState().activeRootIds).toEqual([ROOT_B.rootId, ROOT_A.rootId]);
  });
});

describe('setActiveRoots survives restart with a non-default Main root (restore-order bug)', () => {
  // Reproduces the desktop restore path: zustand rehydrates persisted
  // activeRootIds (Main-first, from a prior setMainRoot) BEFORE
  // runMultiRootRestore calls setActiveRoots(storedDescriptors) with
  // descriptors ordered by the main-process rootsList's insertion order,
  // which has no notion of Main. setActiveRoots must not silently clobber the
  // already-hydrated Main order with the insertion order.
  it('preserves the previously-declared Main order when restore reports original insertion order', () => {
    const { actions, getState } = makeHarness({
      // User previously ran setMainRoot(ROOT_B) — persisted as [B, A].
      activeRootIds: [ROOT_B.rootId, ROOT_A.rootId],
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });

    // Restore reports roots in original add order [A, B] — no Main awareness.
    actions.setActiveRoots([ROOT_A, ROOT_B]);

    expect(getState().activeRootIds).toEqual([ROOT_B.rootId, ROOT_A.rootId]);
  });

  it('appends a newly-discovered root (not previously known) to the END', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_B.rootId, ROOT_A.rootId],
      rootDescriptors: { [ROOT_A.rootId]: ROOT_A, [ROOT_B.rootId]: ROOT_B },
    });

    actions.setActiveRoots([ROOT_A, ROOT_B, ROOT_C]);

    expect(getState().activeRootIds).toEqual([ROOT_B.rootId, ROOT_A.rootId, ROOT_C.rootId]);
  });

  it('drops ids no longer reported (e.g. a root pruned as missing-on-disk during restore)', () => {
    const { actions, getState } = makeHarness({
      activeRootIds: [ROOT_B.rootId, ROOT_A.rootId, ROOT_C.rootId],
      rootDescriptors: {
        [ROOT_A.rootId]: ROOT_A,
        [ROOT_B.rootId]: ROOT_B,
        [ROOT_C.rootId]: ROOT_C,
      },
    });

    // ROOT_C no longer granted/present — pruned from the restore result.
    actions.setActiveRoots([ROOT_A, ROOT_B]);

    expect(getState().activeRootIds).toEqual([ROOT_B.rootId, ROOT_A.rootId]);
  });

  it('falls back to input order when nothing was previously known (first-ever restore)', () => {
    const { actions, getState } = makeHarness({});

    actions.setActiveRoots([ROOT_C, ROOT_A, ROOT_B]);

    expect(getState().activeRootIds).toEqual([ROOT_C.rootId, ROOT_A.rootId, ROOT_B.rootId]);
  });
});

describe('a managed worktree (ADR-0034)', () => {
  const WORKTREE: StoredRootDescriptor = {
    displayName: 'ProjectA-bright-fox',
    path: '/worktrees/ProjectA-bright-fox',
    rootId: 'root-worktree',
    worktree: true,
  };

  it('gets a descriptor from addActiveRoot but never joins the open folders', () => {
    const { actions, getState } = makeHarness({});
    actions.addActiveRoot(ROOT_A);
    actions.addActiveRoot(WORKTREE);
    expect(getState().activeRootIds).toEqual([ROOT_A.rootId]);
    expect(getState().rootDescriptors[WORKTREE.rootId]).toEqual(WORKTREE);
  });

  it('gets a descriptor from setActiveRoots but never joins the open folders', () => {
    const { actions, getState } = makeHarness({});
    actions.setActiveRoots([ROOT_A, WORKTREE, ROOT_B]);
    expect(getState().activeRootIds).toEqual([ROOT_A.rootId, ROOT_B.rootId]);
    expect(Object.keys(getState().rootDescriptors)).toEqual([
      ROOT_A.rootId,
      WORKTREE.rootId,
      ROOT_B.rootId,
    ]);
  });
});

describe('openActiveRoot (ADR-0034: the opened folder is the project)', () => {
  const WORKTREE: StoredRootDescriptor = {
    displayName: 'ProjectA-bright-fox',
    path: '/worktrees/ProjectA-bright-fox',
    rootId: 'root-worktree',
    worktree: true,
  };
  const folderState = {} as FileExplorerState['folderStates'][string];

  it('closes every other open folder and its saved state, keeping worktree descriptors', () => {
    const { actions, getState } = makeHarness({
      folderAccessOrder: [ROOT_A.rootId, ROOT_B.rootId],
      folderStates: { [ROOT_A.rootId]: folderState, [ROOT_B.rootId]: folderState },
    });
    actions.setActiveRoots([ROOT_A, WORKTREE, ROOT_B]);

    actions.openActiveRoot(ROOT_C);

    expect(getState().activeRootIds).toEqual([ROOT_C.rootId]);
    expect(getState().folderAccessOrder).toEqual([]);
    expect(getState().folderStates).toEqual({});
    expect(getState().rootDescriptors).toEqual({
      [WORKTREE.rootId]: WORKTREE,
      [ROOT_C.rootId]: ROOT_C,
    });
  });

  it('converges on the last of two overlapping opens', () => {
    const { actions, getState } = makeHarness({});
    actions.setActiveRoots([ROOT_A]);
    actions.openActiveRoot(ROOT_B);
    actions.openActiveRoot(ROOT_C);
    expect(getState().activeRootIds).toEqual([ROOT_C.rootId]);
    expect(Object.keys(getState().rootDescriptors)).toEqual([ROOT_C.rootId]);
  });
});
