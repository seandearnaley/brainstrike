// @vitest-environment node
// Actual HostCore + native StateStore capture (record-ended-log.mjs) of runs
// that end early (BST-1982): a Stop while text streams and while a tool runs,
// a host close (the app quitting) in both places, and a crash the next host
// recovered. Each run ends with exactly one visible end marker: its activity
// trace when a tool call was cut off, else a standalone end row.

import {
  type AssistantRunEvent,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-host-ended-runs.json';
import { describe, expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

const rows: readonly CommittedAssistantLogRow[] = recording;

/** The recorded run started by this prompt, with its thread's rows. */
function recordedRun(prompt: string) {
  const start = rows.find(
    ({ event }) => event['type'] === 'run.started' && event['prompt'] === prompt
  );
  if (!start || typeof start.event['runId'] !== 'string') {
    throw new Error(`The recording has no run for "${prompt}".`);
  }
  return {
    runId: start.event['runId'],
    threadRows: rows.filter(({ threadId }) => threadId === start.threadId),
  };
}

function project(prompt: string) {
  const { runId, threadRows } = recordedRun(prompt);
  // Test-owned resolver: each run answers the run before it in its thread.
  const runIds = threadRows.flatMap(({ event }) =>
    event['type'] === 'run.started' ? [String(event['runId'])] : []
  );
  const projection = new CommittedAssistantLogProjection({
    identifyRun: (row) => {
      const id = String(row.event['runId']);
      return {
        assistantMessageId: id,
        createdAt: new Date('2026-10-12T12:00:00.000Z'),
        parentMessageId: runIds[runIds.indexOf(id) - 1] ?? null,
        userMessageId: `user-${id}`,
      };
    },
    threadId: threadRows[0]?.threadId ?? '',
  });
  const message = projection
    .acceptCommitted(threadRows)
    .repository.messages.find(({ message: item }) => item.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('The recorded run has no assistant message.');
  }
  return message;
}

/** The message's standalone end rows: always-visible run events of its run's end. */
function endRows(message: ReturnType<typeof project>): AssistantRunEvent[] {
  return message.content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'run.cancelled' && isAlwaysVisibleRunEvent(event) ? [event] : [];
  });
}

function text(message: ReturnType<typeof project>): string {
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** A tool call the run never finished: its activity trace shows how the run ended. */
function cutOffCalls(message: ReturnType<typeof project>): number {
  return message.content.filter((part) => part.type === 'tool-call' && part.result === undefined)
    .length;
}

describe('runs that end early show one end marker', () => {
  it('a Stop while text streams keeps the text and shows a Stopped row', () => {
    const message = project('Write slowly, then stop.');
    expect(text(message)).toBe('Partial reply before the Stop.');
    expect(message.status).toMatchObject({ reason: 'cancelled', type: 'incomplete' });
    expect(cutOffCalls(message)).toBe(0);
    // "Stopped after Ns": the run's committed start and end times.
    const { runId, threadRows } = recordedRun('Write slowly, then stop.');
    const committedAt = (type: string) =>
      threadRows.find(({ event }) => event['type'] === type && event['runId'] === runId)?.ts;
    const startedAt = committedAt('run.started');
    const finishedAt = committedAt('run.finished');
    if (startedAt === undefined || finishedAt === undefined) {
      throw new Error('The recorded Stop has no commit times.');
    }
    expect(endRows(message)).toEqual([
      expect.objectContaining({
        durationMs: finishedAt - startedAt,
        label: 'Stopped',
        status: 'cancelled',
      }),
    ]);
  });

  it('a Stop while a tool runs is marked by that call’s trace alone', () => {
    const message = project('Call the probe, then stop.');
    expect(text(message)).toBe('Checking with the probe.');
    expect(cutOffCalls(message)).toBe(1);
    expect(endRows(message)).toEqual([]);
  });

  it('a host close while text streams keeps the text and names the interruption', () => {
    const message = project('Write slowly, then quit.');
    expect(text(message)).toBe('Partial reply before the quit.');
    expect(endRows(message)).toEqual([
      expect.objectContaining({ detail: 'Host is closing', label: 'Reply interrupted' }),
    ]);
  });

  it('a host close while a tool runs is marked by that call’s trace alone', () => {
    const message = project('Call the probe, then quit.');
    expect(text(message)).toBe('Checking with the probe.');
    expect(cutOffCalls(message)).toBe(1);
    expect(endRows(message)).toEqual([]);
  });

  it('a crash keeps no uncommitted text and the recovered end is one row', () => {
    const message = project('Write slowly, then crash.');
    expect(text(message)).toBe('');
    expect(endRows(message)).toEqual([
      expect.objectContaining({
        detail: 'Host restarted outside a committed decision boundary',
        label: 'Reply interrupted',
      }),
    ]);
  });
});
