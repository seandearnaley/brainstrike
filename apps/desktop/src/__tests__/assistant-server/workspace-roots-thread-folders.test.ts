/**
 * BST-1990 PR 4: in a bound thread the run's roots are the thread's folders.
 * A `root` outside them is refused by type (the folder may be open in the
 * workspace), and a grep or glob with no `root` covers all of them.
 */
import type { RuntimeData } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import {
  markRootDisconnectedByPath,
  RootNotInThreadError,
  resolveWorkspaceRoot,
  resolveWorkspaceSearchScope,
} from '../../assistant-server/workspace-roots';

const ALPHA = { displayName: 'alpha-root', path: '/work/alpha-root', rootId: 'root-alpha' };
const BRAVO = { displayName: 'bravo-root', path: '/work/bravo-root', rootId: 'root-bravo' };

function runtime(overrides: Partial<RuntimeData>): RuntimeData {
  return { provider: 'openai', ...overrides } as RuntimeData;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to refuse');
}

test('a root that is not one of a bound thread’s folders is refused by type', () => {
  const bound = runtime({ boundWorkspaceRootId: ALPHA.rootId, workspaceRoots: [ALPHA] });
  expect(thrown(() => resolveWorkspaceRoot(bound, 'bravo-root'))).toBeInstanceOf(
    RootNotInThreadError
  );
  expect(thrown(() => resolveWorkspaceSearchScope(bound, 'bravo-root'))).toBeInstanceOf(
    RootNotInThreadError
  );
  // A refusal the model corrects: it reaches the model as tool_input_invalid.
  expect(RootNotInThreadError.prototype).toBeInstanceOf(ToolInputError);
  // With no thread binding, the run's roots are the workspace's open folders.
  const unbound = thrown(() => resolveWorkspaceRoot(runtime({ workspaceRoots: [ALPHA] }), 'nope'));
  expect(unbound).toBeInstanceOf(ToolInputError);
  expect(unbound).not.toBeInstanceOf(RootNotInThreadError);
});

test('a search with no root covers every folder of a bound thread; a named root wins', () => {
  const bound = runtime({ boundWorkspaceRootId: ALPHA.rootId, workspaceRoots: [ALPHA, BRAVO] });
  expect(resolveWorkspaceSearchScope(bound)).toEqual({ kind: 'thread', roots: [ALPHA, BRAVO] });
  expect(resolveWorkspaceSearchScope(bound, 'bravo-root')).toEqual({ kind: 'folder', root: BRAVO });
  expect(resolveWorkspaceSearchScope(runtime({ workspaceRoots: [ALPHA, BRAVO] }))).toEqual({
    kind: 'workspace',
    roots: [ALPHA, BRAVO],
  });
});

test('a search with no root still validates the thread binding', () => {
  const unavailable = thrown(() =>
    resolveWorkspaceSearchScope(runtime({ boundWorkspaceRootId: ALPHA.rootId }))
  );
  expect(unavailable).toBeInstanceOf(ToolInputError);
  const gone = thrown(() =>
    resolveWorkspaceSearchScope(
      runtime({ boundWorkspaceRootId: 'root-gone', workspaceRoots: [ALPHA, BRAVO] })
    )
  );
  expect(gone).toBeInstanceOf(ToolInputError);
});

test('a thread folder disconnected during the run refuses the search rather than skipping it', async () => {
  // Its own id: the disconnect is remembered for the rest of this process.
  const folder = { ...BRAVO, rootId: 'root-bravo-disconnected' };
  const db = { query: async <T>() => ({ rows: [{ id: folder.rootId }] as T[] }) };
  await markRootDisconnectedByPath(db, folder.path);
  const bound = runtime({ boundWorkspaceRootId: ALPHA.rootId, workspaceRoots: [ALPHA, folder] });
  expect(thrown(() => resolveWorkspaceSearchScope(bound))).toBeInstanceOf(ToolInputError);
});
