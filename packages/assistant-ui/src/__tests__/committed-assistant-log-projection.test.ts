// Actual HostCore + native StateStore + pinned AI SDK approved-run capture,
// shared unchanged through test-utils' public recorded fixture.
// No private cross-package code/fixture imports or alternate wire decoder.

import { TOOL_CALL_BLOCKED_MESSAGE } from '@brainstrike/assistant-contract/tool-approval';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import hookBlocked from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json';
import { describe, expect, it } from 'vitest';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
  type CommittedAssistantRunIdentity,
} from '../committed-assistant-log-projection';
import { recordedMessage } from './committed-assistant-test-support';

const rows: readonly CommittedAssistantLogRow[] = recording;
const start = rows.find(({ event }) => event['type'] === 'run.started');
const accepted = rows.find(
  ({ event }) => event['type'] === 'command.accepted' && event['method'] === 'run/start'
);
if (
  !(start && accepted) ||
  typeof start.event['runId'] !== 'string' ||
  typeof accepted.event['commandId'] !== 'string'
) {
  throw new Error('Missing committed recording identities.');
}
const threadId = start.threadId;
const runId = start.event['runId'];
const promptId = accepted.event['commandId'];
// Test-owner resolver only: there is deliberately no production ID alias/default.
const identity: CommittedAssistantRunIdentity = {
  assistantMessageId: runId,
  createdAt: new Date('2026-10-06T08:16:33.838Z'),
  metadata: { custom: { hostRunId: runId } },
  parentMessageId: null,
  userMessageId: promptId,
};
function projector(): CommittedAssistantLogProjection {
  return new CommittedAssistantLogProjection({ identifyRun: () => identity, threadId });
}
function answer(projection: CommittedAssistantLogProjection) {
  const message = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing projected recorded answer.');
  }
  return message;
}
function tool(projection: CommittedAssistantLogProjection) {
  const part = answer(projection).content.find((part) => part.type === 'tool-call');
  if (part?.type !== 'tool-call') {
    throw new Error('Missing projected recorded tool.');
  }
  return part;
}

describe('rich committed-log presentation projection', () => {
  it('projects the actual host recording with canonical host approval identity and authoritative result', () => {
    const projection = projector();
    const requested = rows.findIndex(({ event }) => event['type'] === 'interaction.requested');
    const response = rows.findIndex(({ event }) => event['type'] === 'interaction.responded');
    projection.acceptCommitted(rows.slice(0, requested + 1));
    const pending = tool(projection).approval;
    expect(pending?.id).toBe(rows[requested]?.event['interactionId']);
    expect(projection.getSnapshot().pendingInteractions).toEqual([
      expect.objectContaining({
        interactionId: pending?.id,
        runId,
        threadId,
        toolCallId: 'recorded-call-1',
        toolIdentity: 'native-fixture-generation-1',
      }),
    ]);
    projection.acceptCommitted(rows.slice(requested + 1, response));
    expect(tool(projection).approval).toBe(pending);
    projection.acceptCommitted(rows.slice(response));
    expect(tool(projection).approval).toEqual({ approved: true, id: pending?.id });
    expect(tool(projection).approval?.id).not.toMatch(/^aitxt-/);
    const output = rows.find(({ event }) => event['type'] === 'effect.finished')?.event['output'];
    expect(tool(projection).result).toBe(output);
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
    expect(projection.getSnapshot().isRunning).toBe(false);
    expect(answer(projection).status).toEqual({ reason: 'stop', type: 'complete' });
    expect(answer(projection).content.find((part) => part.type === 'text')).toMatchObject({
      text: 'Host run completed.',
    });
    expect(projection.getSnapshot().repository.messages[0]?.message.id).toBe(promptId);
    expect(projection.getSnapshot().repository.messages[1]?.parentId).toBe(promptId);
  });

  it('gap-only committed suffixes, overlapping replay and a fresh projection produce the same rich view', () => {
    const incremental = projector();
    incremental.acceptCommitted(rows.slice(0, 8));
    for (let index = 8; index < rows.length; index += 1) {
      incremental.acceptCommitted(rows.slice(index, index + 1));
    }
    const beforeReplay = incremental.getSnapshot();
    incremental.acceptCommitted(rows);
    incremental.acceptCommitted(structuredClone(recording));
    expect(incremental.getSnapshot()).toBe(beforeReplay);
    const fresh = projector();
    fresh.acceptCommitted(rows);
    expect(incremental.getSnapshot()).toEqual(fresh.getSnapshot());
    const unordered = projector();
    expect(() => unordered.acceptCommitted(rows.slice(1))).toThrow(
      'owner’s contiguous committed prefix'
    );
    expect(unordered.getSnapshot().repository.messages).toEqual([]);
    unordered.acceptCommitted(rows);
    expect(unordered.getSnapshot()).toEqual(fresh.getSnapshot());
  });

  it('merges SDK provider/child metadata independently of host tool input and result authority', () => {
    const withMetadata = rows.map((row) => {
      const chunk = row.event['chunk'] as { type?: string } | undefined;
      const metadata =
        chunk?.type === 'tool-call'
          ? {
              brainstrike: {
                childThreadId: 'child-1',
                toolId: 'sdk-cannot-replace-owner',
                toolIdentity: 'sdk-cannot-replace-owner',
              },
              openai: { requestId: 'request-1' },
            }
          : chunk?.type === 'text-start'
            ? { openai: { traceId: 'trace-1' } }
            : chunk?.type === 'text-end'
              ? { google: { signature: 'signature-1' } }
              : undefined;
      return metadata
        ? { ...row, event: { ...row.event, chunk: { ...chunk, providerMetadata: metadata } } }
        : row;
    });
    const projection = projector();
    projection.acceptCommitted(withMetadata);
    expect(tool(projection).providerMetadata).toEqual({
      brainstrike: {
        childThreadId: 'child-1',
        toolId: 'write_file',
        toolIdentity: 'native-fixture-generation-1',
      },
      openai: { requestId: 'request-1' },
    });
    expect(
      answer(projection).content.find((part) => part.type === 'text')?.providerMetadata
    ).toEqual({ google: { signature: 'signature-1' }, openai: { traceId: 'trace-1' } });
    const fresh = projector();
    for (const row of withMetadata) {
      fresh.acceptCommitted([row]);
    }
    expect(fresh.getSnapshot()).toEqual(projection.getSnapshot());
  });

  it('retains baseline branches, child metadata and unrelated row/part/approval references across actual text publications', async () => {
    const saved = await recordedMessage();
    const childOrigin = saved.content.find((part) => part.type === 'data');
    const baseline = { headId: saved.id, messages: [{ message: saved, parentId: null }] };
    const metadata = { custom: { childOrigin, hostRunId: runId, parentRunId: saved.id } };
    const projection = new CommittedAssistantLogProjection({
      baseline,
      identifyRun: () => ({ ...identity, metadata, parentMessageId: saved.id }),
      threadId,
    });
    const text = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as { type?: string })?.type === 'text-delta'
    );
    projection.acceptCommitted(rows.slice(0, text));
    const before = tool(projection);
    const approval = before.approval;
    const savedRow = projection.getSnapshot().repository.messages[0];
    projection.acceptCommitted(rows.slice(text, text + 1));
    expect(tool(projection)).toBe(before);
    expect(tool(projection).approval).toBe(approval);
    expect(projection.getSnapshot().repository.messages[0]).toBe(savedRow);
    expect(projection.getSnapshot().repository.messages[0]?.message).toBe(saved);
    expect(answer(projection).metadata.custom).toBe(metadata.custom);
    expect(answer(projection).metadata.custom['childOrigin']).toBe(childOrigin);
    projection.acceptCommitted(rows.slice(text + 1));
    expect(
      projection.getSnapshot().repository.messages.find(({ message }) => message.id === promptId)
        ?.parentId
    ).toBe(saved.id);
    expect(baseline.messages).toHaveLength(1);
  });

  it('keeps unknown provider/child chunks as data and closes interrupted streaming parts without creating identities', () => {
    const projection = projector();
    const textStart = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as { type?: string })?.type === 'text-start'
    );
    projection.acceptCommitted(rows.slice(0, textStart + 1));
    const child = {
      childThreadId: 'child',
      parentRunId: runId,
      parentToolCallId: 'recorded-call-1',
    };
    const next = rows[textStart];
    if (!next) {
      throw new Error('Missing recorded text-start.');
    }
    projection.acceptCommitted([
      {
        ...next,
        event: {
          chunk: { data: child, name: 'brainstrike.child-origin', type: 'data' },
          runId,
          type: 'stream.chunk',
        },
        seq: next.seq + 1,
      },
    ]);
    projection.acceptCommitted([
      {
        ...next,
        event: { detail: 'Host restarted', outcome: 'interrupted', runId, type: 'run.finished' },
        seq: next.seq + 2,
      },
    ]);
    const content = answer(projection).content;
    expect(
      content.find((part) => part.type === 'data' && part.name === 'brainstrike.child-origin')
    ).toMatchObject({ data: child });
    expect(content.find((part) => part.type === 'text')).toMatchObject({
      status: { reason: 'other', type: 'incomplete' },
    });
    expect(answer(projection).status).toEqual({
      error: 'Host restarted',
      reason: 'other',
      type: 'incomplete',
    });
    expect(answer(projection).id).toBe(identity.assistantMessageId);
    expect(projection.getSnapshot().isRunning).toBe(false);
  });

  it('names a committed tool by its catalog ID; rows without one keep their recorded tool ID', () => {
    const recordedToolId = rows.find(({ event }) => event['type'] === 'interaction.requested')
      ?.event['toolId'];
    expect(recordedToolId).toEqual(expect.any(String));
    const legacy = projector();
    legacy.acceptCommitted(rows);
    expect(tool(legacy).toolName).toBe(recordedToolId);

    // The host commits the catalog ID on both authoritative tool events.
    const catalogRows = rows.map((row) =>
      row.event['type'] === 'interaction.requested' || row.event['type'] === 'effect.started'
        ? { ...row, event: { ...row.event, toolCatalogId: 'brainstrike.writeFixture' } }
        : row
    );
    const projection = projector();
    const requested = catalogRows.findIndex(
      ({ event }) => event['type'] === 'interaction.requested'
    );
    projection.acceptCommitted(catalogRows.slice(0, requested + 1));
    expect(tool(projection).toolName).toBe('brainstrike.writeFixture');
    projection.acceptCommitted(catalogRows.slice(requested + 1));
    expect(tool(projection).toolName).toBe('brainstrike.writeFixture');
  });
  it('settles a call the host blocked before it ran as declined, with the blocking reason', () => {
    // Recorded from the real CLI host: a global PreToolUse hook blocked askUser.
    const blocked: readonly CommittedAssistantLogRow[] = hookBlocked;
    const blockedStart = blocked.find(({ event }) => event['type'] === 'run.started');
    const blockedRunId = blockedStart?.event['runId'];
    if (!blockedStart || typeof blockedRunId !== 'string') {
      throw new Error('Missing recorded blocked run.');
    }
    const projection = new CommittedAssistantLogProjection({
      identifyRun: () => ({ ...identity, assistantMessageId: blockedRunId }),
      threadId: blockedStart.threadId,
    });
    projection.acceptCommitted(blocked);
    const message = projection
      .getSnapshot()
      .repository.messages.find(({ message }) => message.id === blockedRunId)?.message;
    const part = message?.content.find((part) => part.type === 'tool-call');
    expect(part).toMatchObject({
      isError: false,
      result: {
        kind: 'declined',
        message: TOOL_CALL_BLOCKED_MESSAGE,
        reason: 'Questions are disabled in this workspace',
      },
      toolCallId: 'call_standalone_human_1',
    });
    // The host decided; no user decision was ever offered.
    expect(part?.type === 'tool-call' ? part.approval : 'not a tool').toBeUndefined();
  });
});
