/**
 * The host's `brainstrike.manageCanvas` tool: the shared executor over the
 * thread's tool state (`hostCanvasStore`), exactly as a host call binds it.
 * Each thread owns its own state, so thread scoping is structural: another
 * thread's canvas id is absent from the caller's state.
 */
import type { ManageCanvasInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  CANVAS_STATE_KEY_PREFIX,
  HostCanvasVersionSchema,
  hostCanvasStore,
  type runManageCanvas,
} from '@brainstrike/host-capabilities/native-tools';
import { describe, expect, it } from 'vitest';
import { buildHostNativeTools, memoryToolState } from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

type ThreadState = ReturnType<typeof memoryToolState>;
type ManageCanvasResult = Awaited<ReturnType<typeof runManageCanvas>>;

function runtimeWithThread(threadId = 'thread-1', resourceId = 'resource-1'): RuntimeData {
  return { memory: { resourceId, threadId } } as RuntimeData;
}

/** The thread's stored canvases (latest version per canvas). */
function storedCanvases(state: ThreadState) {
  return state
    .entries(CANVAS_STATE_KEY_PREFIX)
    .map(([, value]) => HostCanvasVersionSchema.parse(value));
}

async function run(
  state: ThreadState | undefined,
  input: ManageCanvasInput,
  runtimeData: RuntimeData = runtimeWithThread()
): Promise<ManageCanvasResult> {
  const tools = buildHostNativeTools(runtimeData, {
    ids: [NATIVE_TOOL_ID.manageCanvas],
    ports: { canvas: state ? hostCanvasStore(state) : undefined },
  });
  return await requireToolExecute<ManageCanvasResult>(tools, NATIVE_TOOL_ID.manageCanvas)(input);
}

describe('manageCanvas host tool', () => {
  it('is registered in the host native tool fold with its canonical schema', () => {
    const tools = buildHostNativeTools(runtimeWithThread());
    expect(tools['brainstrike.manageCanvas']).toMatchObject({
      description: expect.any(String),
      execute: expect.any(Function),
      id: 'brainstrike.manageCanvas',
      inputSchema: expect.any(Object),
    });
  });

  it('creates, updates, rewrites, and lists a versioned canvas for the active thread', async () => {
    const state = memoryToolState();
    const created = await run(state, {
      action: 'create',
      html: '<p>Hello world</p>',
      title: 'Draft',
    });
    expect(created).toEqual({ canvasId: expect.any(String), version: 1 });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    await expect(
      run(state, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'Canvas',
        oldString: 'world',
      })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 2 });
    await expect(
      run(state, { action: 'rewrite', canvasId: created.canvasId, html: '<p>Final</p>' })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 3 });

    const listed = await run(state, { action: 'list' });
    expect(listed).toEqual({
      canvases: [
        {
          canvasId: created.canvasId,
          createdAt: expect.any(String),
          title: 'Draft',
          version: 3,
        },
      ],
      truncated: false,
    });
    // Listings must never inline canvas html into model context.
    expect(JSON.stringify(listed)).not.toContain('<p>Final</p>');
  });

  it('scopes mutations to the calling thread: a foreign canvas id is uniformly not_found', async () => {
    const mine = memoryToolState();
    const created = await run(mine, { action: 'create', html: '<p>Mine</p>', title: 'Mine' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    const other = memoryToolState();
    await expect(
      run(
        other,
        { action: 'rewrite', canvasId: created.canvasId, html: '<p>Stolen</p>' },
        runtimeWithThread('other-thread', 'other-resource')
      )
    ).resolves.toEqual({ error: 'not_found', ok: false });
    // The other thread's write never landed, in either thread's state.
    expect(other.values.size).toBe(0);
    expect(storedCanvases(mine)).toEqual([
      expect.objectContaining({ html: '<p>Mine</p>', version: 1 }),
    ]);
  });

  it('propagates structured no-match and ambiguous-match results', async () => {
    const state = memoryToolState();
    const created = await run(state, { action: 'create', html: 'same same', title: 'Draft' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }

    await expect(
      run(state, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'new',
        oldString: 'missing',
      })
    ).resolves.toEqual({ error: 'no_match', ok: false });
    await expect(
      run(state, {
        action: 'update',
        canvasId: created.canvasId,
        newString: 'new',
        oldString: 'same',
      })
    ).resolves.toEqual({ error: 'ambiguous_match', ok: false });
  });

  it('refuses an empty create with a hint to create when the content is ready, and writes nothing', async () => {
    const state = memoryToolState();
    // The verifier run 6/7 shape: a titled shell created "to receive the report".
    const refused = await run(state, {
      action: 'create',
      html: '<html><head><title>Report</title></head><body></body></html>',
      title: 'Findings report',
    });
    expect(refused).toEqual({
      error: 'empty_document',
      hint: expect.stringContaining('content is ready'),
      ok: false,
    });
    // Mutation: checking AFTER the store write (or not at all) leaves a canvas.
    expect(state.values.size).toBe(0);
  });

  it('leaves update and rewrite unchanged: an empty replacement and an empty rewrite still version', async () => {
    const state = memoryToolState();
    const created = await run(state, { action: 'create', html: '<p>draft</p>', title: 'Draft' });
    if (!('canvasId' in created)) {
      throw new Error('expected create result');
    }
    // update's empty newString is the documented "delete the match" — a CREATE
    // rule must not leak into it.
    await expect(
      run(state, {
        action: 'update',
        canvasId: created.canvasId,
        newString: '',
        oldString: 'draft',
      })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 2 });
    // rewrite to an empty document is a deliberate act on a document the user
    // already has, and stays reversible through the version stepper.
    await expect(
      run(state, { action: 'rewrite', canvasId: created.canvasId, html: '<p></p>' })
    ).resolves.toEqual({ canvasId: created.canvasId, version: 3 });
  });

  it('returns a structured error when the call has no thread canvas store', async () => {
    // `NativeToolPorts.canvas` is absent without an active thread.
    await expect(run(undefined, { action: 'list' }, {} as RuntimeData)).resolves.toEqual({
      error: 'no_active_thread',
      hint: expect.stringContaining('thread'),
      ok: false,
    });
  });
});
