// @vitest-environment node
// Actual standalone host recording (real bin, MCP lab reference server, one
// refused and one protocol-mismatched server), shared through test-utils.
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import recording from '@brainstrike/test-utils/fixtures/committed-host-mcp-unavailable.json';
import { expect, it } from 'vitest';
import { isAlwaysVisibleRunEvent } from '../assistant-run-event-derivation';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';

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
const runId = start.event['runId'];
const promptId = accepted.event['commandId'];
const createdAt = new Date('2026-10-08T17:00:00.000Z');

it('shows each committed unavailable MCP server as an always-visible run notice', () => {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt,
      metadata: { custom: { hostRunId: runId } },
      parentMessageId: null,
      userMessageId: promptId,
    }),
    threadId: start.threadId,
  });
  projection.acceptCommitted(rows);
  const message = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (message?.role !== 'assistant') {
    throw new Error('Missing projected recorded answer.');
  }
  const notices = message.content.flatMap((part) => {
    const event = readAssistantRunEventDataPart(part);
    return event?.kind === 'mcp.tools.unavailable' ? [event] : [];
  });
  const committed = rows.flatMap(({ event }) =>
    event['type'] === 'mcp.tools.unavailable' ? [event] : []
  );
  expect(committed).toHaveLength(2);
  expect(notices).toEqual(
    committed.map((event) =>
      expect.objectContaining({
        detail: `${String(event['serverId'])} skipped for this request — ${String(event['reason'])}`,
        label: 'MCP server tools unavailable',
        metadata: { reason: event['reason'], scope: 'server', serverName: event['serverId'] },
        runId,
        status: 'failed',
        timestamp: createdAt.toISOString(),
      })
    )
  );
  expect(notices.every((event) => isAlwaysVisibleRunEvent(event))).toBe(true);
  // The run itself still completed with the reachable server's tool.
  expect(message.status).toEqual({ reason: 'stop', type: 'complete' });
});
