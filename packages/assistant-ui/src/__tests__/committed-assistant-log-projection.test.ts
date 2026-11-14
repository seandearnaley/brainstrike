// @vitest-environment node
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
import { CommittedRowUnreadableError, record } from '../committed-host-event-readers';
import { PERSON_INPUT_DATA_NAME } from '../committed-person-input';
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
/** A committed compaction's host-written lists, empty (BST-2527). */
const NO_LISTS = { earlierRequests: [], filesEdited: [], toolsLoaded: [] };
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
    const lists = {
      earlierRequests: ['Move the port to 8443.'],
      filesEdited: [{ edits: 2, path: 'src/server.ts' }],
      toolsLoaded: ['brainstrike_lspInspect'],
    };
    projection.acceptCommitted([
      {
        event: {
          ...lists,
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
    // The host's lists ride beside the fallback's line, as committed.
    expect(answer(projection).content.at(-1)).toEqual({
      data: { ...lists, kind: 'deterministic', reason: 'pre-request', summary, turnsCompacted: 1 },
      name: HOST_CONTEXT_COMPACTED_DATA_NAME,
      type: 'data',
    });
  });

  it('draws a person’s input the running agent read as their message inside its reply', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    // The exact event the host commits when a run reads the person's input at a step.
    projection.acceptCommitted([
      {
        event: {
          delivery: { entries: [], inputs: ['input-command-1'] },
          messages: [
            {
              content: [
                { text: 'Also add a title.', type: 'text' },
                { data: 'aGk=', mediaType: 'image/png', type: 'file' },
                // What the host read for it (a mentioned file) is the model's, never their words.
                {
                  providerOptions: { brainstrike: { context: true } },
                  text: 'Referenced file notes.md: ...',
                  type: 'text',
                },
              ],
              providerOptions: { brainstrike: { intake: true } },
              role: 'user',
            },
          ],
          runId,
          type: 'model.messages',
        },
        seq: last.seq + 1,
        threadId,
      },
    ]);
    expect(answer(projection).content.at(-1)).toEqual({
      data: { images: ['data:image/png;base64,aGk='], text: 'Also add a title.' },
      name: PERSON_INPUT_DATA_NAME,
      type: 'data',
    });
  });

  it('shows a person’s input faded at the reply’s end from its send until the run reads it there', () => {
    const projection = projector();
    const finished = rows.findIndex(({ event }) => event['type'] === 'run.finished');
    const running = rows.slice(0, finished);
    projection.acceptCommitted(running);
    let seq = running.at(-1)?.seq ?? 0;
    const commit = (event: Record<string, unknown>) =>
      projection.acceptCommitted([{ event, seq: ++seq, threadId }]);
    commit({
      commandId: 'input-command-1',
      method: 'run/input',
      payload: {
        attachments: [
          {
            data: 'data:image/png;base64,aGk=',
            mediaType: 'image/png',
            name: 'a.png',
            type: 'image',
          },
        ],
        commandId: 'input-command-1',
        modelId: 'scripted',
        prompt: 'Also add a title.',
        runId,
        threadId,
      },
      result: { accepted: true },
      type: 'command.accepted',
    });
    const unread = {
      data: { images: ['data:image/png;base64,aGk='], text: 'Also add a title.', unread: true },
      name: PERSON_INPUT_DATA_NAME,
      type: 'data',
    };
    expect(answer(projection).content.at(-1)).toEqual(unread);
    // The step still in flight when it was sent ends before it.
    commit({ runId, type: 'step.noted' });
    expect(answer(projection).content.at(-2)).toMatchObject({ data: { type: 'step.noted' } });
    expect(answer(projection).content.at(-1)).toEqual(unread);
    commit({
      delivery: { entries: [], inputs: ['input-command-1'] },
      messages: [
        {
          content: [
            { text: 'Also add a title.', type: 'text' },
            { data: 'data:image/png;base64,aGk=', mediaType: 'image/png', type: 'file' },
          ],
          role: 'user',
        },
      ],
      runId,
      type: 'model.messages',
    });
    const parts = answer(projection).content;
    expect(
      parts.filter((part) => part.type === 'data' && part.name === PERSON_INPUT_DATA_NAME)
    ).toEqual([
      { ...unread, data: { images: ['data:image/png;base64,aGk='], text: 'Also add a title.' } },
    ]);
    expect(parts.at(-2)).toMatchObject({ data: { type: 'step.noted' } });
  });

  it('keeps a step’s text before its tool call when an input arrived while the step ran', () => {
    const projection = projector();
    const stepStarted = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' && record(event['chunk'])?.['type'] === 'start-step'
    );
    const opened = rows.slice(0, stepStarted + 1);
    projection.acceptCommitted(opened);
    let seq = opened.at(-1)?.seq ?? 0;
    const commit = (event: Record<string, unknown>) =>
      projection.acceptCommitted([{ event, seq: ++seq, threadId }]);
    const payload = {
      commandId: 'mid-step',
      modelId: 'scripted',
      prompt: 'Name it notes.md.',
      runId,
      threadId,
    };
    commit({
      commandId: 'mid-step',
      method: 'run/input',
      payload,
      result: { accepted: true },
      type: 'command.accepted',
    });
    // The step commits its text with the tool call it precedes, and the call's chunk follows.
    const call = { input: {}, toolCallId: 'call-x', toolName: 'write_file', type: 'tool-call' };
    commit({
      messages: [{ content: [{ text: 'Writing it.', type: 'text' }, call], role: 'assistant' }],
      runId,
      type: 'model.step',
    });
    commit({ chunk: call, runId, type: 'stream.chunk' });
    const parts = answer(projection).content;
    const text = parts.findIndex((part) => part.type === 'text' && part.text === 'Writing it.');
    const tool = parts.findIndex(
      (part) => part.type === 'tool-call' && part.toolCallId === 'call-x'
    );
    expect(text).toBeGreaterThan(-1);
    expect(text).toBeLessThan(tool);
    expect(parts.at(-1)).toMatchObject({ data: { text: 'Name it notes.md.', unread: true } });
  });

  it('draws an input a retried attempt read, though the failed attempt’s step never committed', () => {
    const projection = projector();
    const stepStarted = rows.findIndex(
      ({ event }) =>
        event['type'] === 'stream.chunk' && record(event['chunk'])?.['type'] === 'start-step'
    );
    const opened = rows.slice(0, stepStarted + 1);
    projection.acceptCommitted(opened);
    let seq = opened.at(-1)?.seq ?? 0;
    const commit = (event: Record<string, unknown>) =>
      projection.acceptCommitted([{ event, seq: ++seq, threadId }]);
    const payload = {
      commandId: 'stalled',
      modelId: 'scripted',
      prompt: 'Still there?',
      runId,
      threadId,
    };
    commit({
      commandId: 'stalled',
      method: 'run/input',
      payload,
      result: { accepted: true },
      type: 'command.accepted',
    });
    commit({
      attempt: 1,
      detail: 'The provider stopped responding.',
      maxAttempts: 2,
      reason: 'stalled',
      recovered: true,
      runId,
      type: 'run.attempt',
    });
    // The retry's first step reads it before its own start-step.
    commit({
      delivery: { entries: [], inputs: ['stalled'] },
      messages: [{ content: [{ text: 'Still there?', type: 'text' }], role: 'user' }],
      runId,
      type: 'model.messages',
    });
    const inputs = answer(projection).content.filter(
      (part) => part.type === 'data' && part.name === PERSON_INPUT_DATA_NAME
    );
    expect(inputs).toEqual([
      { data: { images: [], text: 'Still there?' }, name: PERSON_INPUT_DATA_NAME, type: 'data' },
    ]);
  });

  it('keeps an input a stopped run never read at its reply’s end until the next run takes it', () => {
    const next = { ...identity, assistantMessageId: 'next-answer', userMessageId: 'next-prompt' };
    const projection = new CommittedAssistantLogProjection({
      identifyRun: (row) => (row.event['runId'] === runId ? identity : next),
      threadId,
    });
    projection.acceptCommitted(rows);
    let seq = rows.at(-1)?.seq ?? 0;
    const commit = (event: Record<string, unknown>) =>
      projection.acceptCommitted([{ event, seq: ++seq, threadId }]);
    const payload = {
      commandId: 'late-input',
      modelId: 'scripted',
      prompt: 'One more.',
      runId,
      threadId,
    };
    commit({
      commandId: 'late-input',
      method: 'run/input',
      payload,
      result: { accepted: true },
      type: 'command.accepted',
    });
    expect(answer(projection).content.at(-1)).toMatchObject({
      data: { text: 'One more.', unread: true },
    });
    // The idle thread's next run takes it as its own prompt.
    commit({
      delivery: { entries: [], inputs: ['late-input'], messageId: 'delivery', via: 'next-turn' },
      modelId: 'scripted',
      prompt: 'One more.',
      runId: 'next-run',
      type: 'run.started',
    });
    expect(
      answer(projection).content.some(
        (part) => part.type === 'data' && part.name === PERSON_INPUT_DATA_NAME
      )
    ).toBe(false);
    const prompt = projection
      .getSnapshot()
      .repository.messages.find(({ message }) => message.id === 'next-prompt')?.message;
    expect(prompt?.content).toEqual([{ text: 'One more.', type: 'text' }]);
  });

  it('keeps an agentic compaction’s reason, turns, summarizer model and usage on its card part', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    const summary = '## Goal\nShip it.';
    projection.acceptCommitted([
      {
        event: {
          ...NO_LISTS,
          compactedRunIds: ['earlier-run', 'middle-run'],
          kind: 'agentic',
          modelId: 'openai::gpt-6-sol',
          reason: 'pre-request',
          runId,
          summary,
          type: 'context.compacted',
          // The SDK totalUsage exactly as the summarizer side call reported it.
          usage: {
            inputTokenDetails: { cacheReadTokens: 0 },
            inputTokens: 12_400,
            outputTokens: 310,
            totalTokens: 12_710,
          },
        },
        seq: last.seq + 1,
        threadId,
      },
    ]);
    expect(answer(projection).content.at(-1)).toEqual({
      data: {
        ...NO_LISTS,
        kind: 'agentic',
        modelId: 'openai::gpt-6-sol',
        reason: 'pre-request',
        summary,
        turnsCompacted: 2,
        usage: { inputTokens: 12_400, outputTokens: 310 },
      },
      name: HOST_CONTEXT_COMPACTED_DATA_NAME,
      type: 'data',
    });
  });

  it('counts the steps of a running turn each compaction’s summary covers (BST-2531, BST-2527)', () => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    const compacted = (seq: number, stepNumber: number, reason: string, kept?: number[]) => ({
      event: {
        ...NO_LISTS,
        compactedRunIds: [],
        kind: 'deterministic',
        reason,
        runId,
        summary: 'Dropped.',
        through: { ...(kept ? { kept } : {}), runId, stepNumber },
        type: 'context.compacted',
      },
      seq,
      threadId,
    });
    // The first kept its steps 2 and 4 word for word, so it replaced five of seven.
    // The second merged the first and names its kept steps too (BST-2527).
    projection.acceptCommitted([
      compacted(last.seq + 1, 6, 'pre-request', [2, 4]),
      compacted(last.seq + 2, 10, 'request-trim', [2, 4]),
    ]);
    const cards = answer(projection).content.filter(
      (part) => part.type === 'data' && part.name === HOST_CONTEXT_COMPACTED_DATA_NAME
    );
    // Its summary covers steps 0 to 10 but the two kept ones.
    expect(cards.map((part) => (part.type === 'data' ? part.data : undefined))).toEqual([
      {
        ...NO_LISTS,
        kind: 'deterministic',
        reason: 'pre-request',
        stepsCompacted: 5,
        summary: 'Dropped.',
        turnsCompacted: 0,
      },
      {
        ...NO_LISTS,
        kind: 'deterministic',
        reason: 'request-trim',
        stepsCompacted: 9,
        summary: 'Dropped.',
        turnsCompacted: 0,
      },
    ]);
  });

  it.each([
    ['an unknown reason', { reason: 'budget' }],
    ['no compacted runs', { compactedRunIds: [] }],
    ['a step it cannot read', { through: { runId, stepNumber: -1 } }],
    ['usage without its token counts', { modelId: 'openai::gpt-6-sol', usage: { totalTokens: 9 } }],
    ['no host-written lists (BST-2527)', { earlierRequests: undefined }],
    ['an unreadable edited file', { filesEdited: [{ path: 'src/a.ts' }] }],
  ])('stops before a committed compaction with %s', (_label, change) => {
    const projection = projector();
    projection.acceptCommitted(rows);
    const last = rows.at(-1);
    if (!last) {
      throw new Error('Missing recorded rows.');
    }
    expect(() =>
      projection.acceptCommitted([
        {
          event: {
            ...NO_LISTS,
            compactedRunIds: ['earlier-run'],
            kind: 'deterministic',
            reason: 'context-overflow',
            runId,
            summary: 'Deterministic fallback.',
            type: 'context.compacted',
            ...change,
          },
          seq: last.seq + 1,
          threadId,
        },
      ])
    ).toThrow(CommittedRowUnreadableError);
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
  // BST-2360: a command's approval says when it runs with no OS sandbox.
  it('carries a committed approval’s sandbox fact to its tool card', () => {
    const withFact = (sandboxed: unknown) => {
      const projection = projector();
      projection.acceptCommitted(
        rows.map((row) =>
          row.event['type'] === 'interaction.requested'
            ? { ...row, event: { ...row.event, sandboxed } }
            : row
        )
      );
      return tool(projection).providerMetadata?.['brainstrike']?.['sandboxed'];
    };
    expect(withFact(false)).toBe(false);
    expect(withFact(true)).toBe(true);
    expect(withFact('no')).toBeUndefined();
  });
});
