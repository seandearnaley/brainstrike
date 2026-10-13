// Actual HostCore + native StateStore + pinned AI SDK approved-run capture,
// shared unchanged through test-utils' public recorded fixture.
// No private cross-package code/fixture imports or alternate wire decoder.

import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { TOOL_CALL_BLOCKED_MESSAGE } from '@brainstrike/assistant-contract/tool-approval';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json';
import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json';
import hookBlocked from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json';
import { describe, expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import { committedApprovalGrant, committedApprovalOptions } from '../committed-approval-options';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
  type CommittedAssistantRunIdentity,
} from '../committed-assistant-log-projection';
import { HOST_CONTEXT_COMPACTED_DATA_NAME } from '../compaction-summary-message';
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
    expect(tool(projection).approval).toMatchObject({ approved: true, id: pending?.id });
    expect(tool(projection).approval?.id).toBe(rows[requested]?.event['interactionId']);
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
    const textOptions = { google: { signature: 'signature-1' }, openai: { traceId: 'trace-1' } };
    const withMetadata = rows.map((row) => {
      const chunk = row.event['chunk'] as { type?: string } | undefined;
      if (chunk?.type === 'tool-call') {
        const metadata = {
          brainstrike: {
            childThreadId: 'child-1',
            toolId: 'sdk-cannot-replace-owner',
            toolIdentity: 'sdk-cannot-replace-owner',
          },
          openai: { requestId: 'request-1' },
        };
        return { ...row, event: { ...row.event, chunk: { ...chunk, providerMetadata: metadata } } };
      }
      if (row.event['type'] !== 'model.step') {
        return row;
      }
      // A step's text and its provider options are committed in its `model.step` messages.
      const messages = (row.event['messages'] as { content: unknown[]; role: string }[]).map(
        (message) => ({
          ...message,
          content: message.content.map((part) =>
            (part as { type?: string }).type === 'text'
              ? { ...(part as object), providerOptions: textOptions }
              : part
          ),
        })
      );
      return { ...row, event: { ...row.event, messages } };
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
    ).toEqual(textOptions);
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
    const text = rows.findLastIndex(({ event }) => event['type'] === 'model.step');
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
    const lastStep = rows.findLastIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' &&
        (event['chunk'] as { type?: string })?.type === 'start-step'
    );
    projection.acceptCommitted(rows.slice(0, lastStep + 1));
    // The open step streams live text that never commits before the host restarts.
    projection.acceptLive(runId, { id: 'text-1', type: 'text-start' });
    projection.acceptLive(runId, { id: 'text-1', text: 'Host run', type: 'text-delta' });
    const child = {
      childThreadId: 'child',
      parentRunId: runId,
      parentToolCallId: 'recorded-call-1',
    };
    const next = rows[lastStep];
    if (!next) {
      throw new Error('Missing the recorded final step.');
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
      text: 'Host run',
    });
    expect(answer(projection).status).toEqual({
      error: 'Host restarted',
      reason: 'other',
      type: 'incomplete',
    });
    expect(answer(projection).id).toBe(identity.assistantMessageId);
    expect(projection.getSnapshot().isRunning).toBe(false);
    // BST-1981: the host's interruption is shown as a marker at every detail
    // level, as a Stop shows "Stopped after Ns", carrying the host's reason.
    const markers = content.flatMap((part) => {
      const event = readAssistantRunEventDataPart(part);
      return event?.runId === runId && event.label === 'Reply interrupted' ? [event] : [];
    });
    expect(markers).toEqual([
      expect.objectContaining({ detail: 'Host restarted', kind: 'run.cancelled' }),
    ]);
    expect(isAlwaysVisibleRunEvent(markers[0])).toBe(true);
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

  it('surfaces a committed withheld observational memory reason for the thread view', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    expect(projection.getSnapshot().observationWithheld).toBeUndefined();
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    // The exact event the host commits when a branched thread's run gets no OM.
    projection.acceptCommitted([
      ...rows,
      {
        event: { reason: 'branched-thread', runId, type: 'memory.observation.withheld' },
        seq: last.seq + 1,
        threadId,
      },
    ]);
    expect(projection.getSnapshot().observationWithheld).toBe('branched-thread');
  });

  it('shows a committed deterministic compaction fallback as a compaction card part of its run', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    const summary =
      'Deterministic fallback: dropped 3 earlier turns (6 messages) after an agentic summarizer failure; no summarization model ran.';
    // The exact event the host commits when its summarizer fails past the trigger.
    projection.acceptCommitted([
      {
        event: {
          compactedRunIds: ['earlier-run'],
          kind: 'deterministic',
          reason: 'pre-request',
          runId,
          summary,
          type: 'context.compacted',
        },
        seq: last.seq + 1,
        threadId,
      },
    ]);
    expect(answer(projection).content.at(-1)).toEqual({
      data: { kind: 'deterministic', summary },
      name: HOST_CONTEXT_COMPACTED_DATA_NAME,
      type: 'data',
    });
  });

  it('offers a permission approval’s grants and maps the chosen one to the call’s category or tool', () => {
    // Recorded from a real host run: the first edit was approved with a session grant.
    const run: readonly CommittedAssistantLogRow[] = granted;
    const grantedStart = run.find(({ event }) => event['type'] === 'run.started');
    const grantedRunId = grantedStart?.event['runId'];
    if (!grantedStart || typeof grantedRunId !== 'string') {
      throw new Error('Missing recorded granted run.');
    }
    const projection = new CommittedAssistantLogProjection({
      identifyRun: () => ({ ...identity, assistantMessageId: grantedRunId }),
      threadId: grantedStart.threadId,
    });
    const tools = () =>
      projection
        .getSnapshot()
        .repository.messages.find(({ message }) => message.id === grantedRunId)
        ?.message.content.filter((part) => part.type === 'tool-call') ?? [];
    const requested = run.findIndex(({ event }) => event['type'] === 'interaction.requested');
    projection.acceptCommitted(run.slice(0, requested + 1));
    expect(tools()[0]?.approval?.options).toEqual(committedApprovalOptions('edit'));
    const [pending] = projection.getSnapshot().pendingInteractions;
    expect(pending).toMatchObject({ permissionToolId: 'brainstrike.writeFixture', risk: 'edit' });
    if (!pending) {
      throw new Error('Missing pending approval.');
    }
    expect(committedApprovalGrant('grant-session', pending)).toEqual({
      category: 'edit',
      scope: 'session',
    });
    expect(committedApprovalGrant('grant-tool', pending)).toEqual({
      scope: 'tool',
      toolId: 'brainstrike.writeFixture',
    });
    expect(committedApprovalGrant('approve', pending)).toBeUndefined();

    projection.acceptCommitted(run.slice(requested + 1));
    const [first, second] = tools();
    expect(first?.approval).toMatchObject({ approved: true });
    // The granted second edit never asked.
    expect(second?.approval).toBeUndefined();
    expect(second?.result).toEqual(expect.objectContaining({ path: expect.any(String) }));
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
  });
  it('carries a committed approval’s host execution context to its tool card', () => {
    const executionContext = {
      allowedDomains: [],
      allowRead: [],
      allowWrite: [],
      defaultReadAccess: 'permissive',
      executorKind: 'fence',
      language: 'python',
      policyFingerprint: 'fingerprint',
      scratchParentDir: '/tmp',
      timeoutMs: 30_000,
    };
    // The host commits it on interaction.requested for a run_python approval.
    const withContext = rows.map((row) =>
      row.event['type'] === 'interaction.requested'
        ? { ...row, event: { ...row.event, executionContext } }
        : row
    );
    const projection = projector();
    projection.acceptCommitted(withContext);
    expect(tool(projection).providerMetadata?.['brainstrike']).toMatchObject({ executionContext });
    const plain = projector();
    plain.acceptCommitted(rows);
    expect(tool(plain).providerMetadata?.['brainstrike']?.['executionContext']).toBeUndefined();
  });
  // BST-1990 (D4): a file tool's approval names the folder the host resolved.
  it('carries a committed approval’s target folder to its tool card', () => {
    const targetRoot = { displayName: 'alpha-root', rootId: 'r-alpha' };
    const withTarget = rows.map((row) =>
      row.event['type'] === 'interaction.requested'
        ? { ...row, event: { ...row.event, targetRoot } }
        : row
    );
    const projection = projector();
    projection.acceptCommitted(withTarget);
    expect(tool(projection).providerMetadata?.['brainstrike']).toMatchObject({ targetRoot });
    const malformed = projector();
    malformed.acceptCommitted(
      rows.map((row) =>
        row.event['type'] === 'interaction.requested'
          ? { ...row, event: { ...row.event, targetRoot: { rootId: 'r-alpha' } } }
          : row
      )
    );
    expect(tool(malformed).providerMetadata?.['brainstrike']?.['targetRoot']).toBeUndefined();
  });
});
