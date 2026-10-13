/**
 * BST-1990 (D4): a run the host refuses before admitting it reaches the client
 * with the "not admitted" JSON-RPC code and the host's own refusal text, so the
 * client may hand the user's message back for a resend. Nothing was committed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundaryFailureError,
  DEFAULT_PERMISSION_POLICIES,
  INTERNAL_FAULT,
  refusal,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';
import { BOUNDARY_REFUSAL_RPC_CODE, toBoundaryResponseError } from '../src/boundary-wire.js';
import { attachAgentHost } from '../src/client.js';
import { rejectHostRunAdmission } from '../src/core-run-lifecycle.js';
import type { HostPlatform } from '../src/ports.js';
import { HOST_RUN_NOT_ADMITTED_CODE } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';

const FAILURE = refusal({
  category: 'conflict',
  code: 'workspace.folder-removed',
  message: 'The folder "bravo" was removed from the workspace.',
  remedy: 'Add it back, or choose another folder for this thread.',
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

test.each([
  { cause: new BoundaryFailureError(FAILURE), expected: FAILURE, kind: 'typed refusal' },
  {
    cause: new Error('The selected workspace root is no longer mounted'),
    expected: { ...INTERNAL_FAULT, correlationId: expect.any(String) },
    kind: 'untyped fault',
  },
])(
  'a $kind before admission keeps the not-admitted fact and safe reason',
  async ({ cause, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m6-not-admitted-'));
    const platform: HostPlatform = {
      close: async () => undefined,
      maxSteps: 2,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => {
        throw cause;
      },
      tools: {},
    };
    const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    const client = await attachAgentHost(host.record);
    cleanup.push(async () => {
      await client.close();
      await host.close();
      await rm(root, { force: true, recursive: true });
    });
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

    const refusal: unknown = await client
      .request('run/start', {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Hello',
        threadId,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause
      );

    expect(refusal).toBeInstanceOf(BoundaryFailureError);
    expect((refusal as BoundaryFailureError).failure).toEqual(expected);
    expect(refusal).toMatchObject({
      cause: { code: HOST_RUN_NOT_ADMITTED_CODE, data: expected },
      code: expected.code,
    });
    const rows = await client.request('thread/read', { fromSeq: 0, threadId });
    expect(rows.rows.some((row) => row.event.type === 'run.started')).toBe(false);
  }
);

// The same typed refusal after commit is not proof that resending is safe.
test('a failure after commit retains its cause and cannot acquire the not-admitted discriminator', async () => {
  const original = new BoundaryFailureError(FAILURE);
  const cause = await rejectHostRunAdmission(
    'committed-thread',
    original,
    undefined,
    undefined,
    new Map(),
    true
  ).catch((error: unknown) => error);
  expect(cause).toBe(original);
  const sent = toBoundaryResponseError(cause, vi.fn());
  expect(sent.code).toBe(BOUNDARY_REFUSAL_RPC_CODE);
  expect(sent.code).not.toBe(HOST_RUN_NOT_ADMITTED_CODE);
  expect(sent.data).toEqual(FAILURE);
});
