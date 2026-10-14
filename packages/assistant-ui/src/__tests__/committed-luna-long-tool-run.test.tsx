// @vitest-environment jsdom
// Exact desktop HostCore rows from a GPT-6 Luna run of one-call steps: a glob,
// a grep and twelve sequential reads, each step opening with Luna's opaque
// reasoning. Recorded by assistant-long-tool-run.desktop.test.ts; only the
// loopback provider is fake. The October 14 owner screenshot drew this shape
// as one "Read · 1 step" group per model step.
import '@testing-library/jest-dom/vitest';
import type { ThreadAssistantMessage } from '@assistant-ui/react';
import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  ACTIVITY_GROUP_KEY,
  groupAssistantActivityPart,
  isActivityPart,
} from '../assistant-activity-grouping';
import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogRow,
} from '../committed-assistant-log-projection';
import { Harness } from './assistant-activity-timeline-fixtures';
import recording from './fixtures/committed-luna-long-tool-run.json';

const rows: readonly CommittedAssistantLogRow[] = recording;
const start = rows.find(({ event }) => event['type'] === 'run.started');
const recordedRunId = start?.event['runId'];
if (!(start && typeof recordedRunId === 'string')) {
  throw new Error('The recording has no run.');
}
const runId: string = recordedRunId;
const calls = rows.filter(({ event }) => event['type'] === 'effect.started').length;

function answerAfter(prefix: readonly CommittedAssistantLogRow[]): ThreadAssistantMessage {
  const projection = new CommittedAssistantLogProjection({
    identifyRun: () => ({
      assistantMessageId: runId,
      createdAt: new Date(start?.ts ?? 0),
      parentMessageId: null,
      userMessageId: 'recorded-prompt',
    }),
    threadId: start?.threadId ?? '',
  });
  projection.acceptCommitted(prefix);
  const answer = projection
    .getSnapshot()
    .repository.messages.find(({ message }) => message.id === runId)?.message;
  if (answer?.role !== 'assistant') {
    throw new Error('The recording has no assistant answer.');
  }
  return answer;
}

/** Contiguous runs of grouped parts that hold activity: what draws an activity group. */
function activityGroups(message: ThreadAssistantMessage): number {
  let groups = 0;
  let open = false;
  let counted = false;
  for (const part of message.content) {
    if (groupAssistantActivityPart(part as never)[0] !== ACTIVITY_GROUP_KEY) {
      open = false;
      continue;
    }
    if (!open) {
      open = true;
      counted = false;
    }
    if (!counted && isActivityPart(part)) {
      groups += 1;
      counted = true;
    }
  }
  return groups;
}

test('every committed prefix of a run of one-call steps draws at most one activity group', () => {
  expect(calls).toBe(14);
  for (let end = rows.indexOf(start) + 1; end <= rows.length; end += 1) {
    const answer = answerAfter(rows.slice(0, end));
    expect(activityGroups(answer)).toBeLessThanOrEqual(1);
    // Luna's reasoning is opaque: it never becomes a thinking disclosure.
    expect(answer.content.some((part) => part.type === 'reasoning')).toBe(false);
  }
});

test('the settled run renders one collapsed group naming every step, then the reply', async () => {
  const answer = answerAfter(rows);
  expect(answer.content.filter((part) => part.type === 'tool-call')).toHaveLength(calls);
  render(
    <Harness
      adapter={{
        run() {
          throw new Error('Hydration must not invoke a model.');
        },
      }}
      initialMessages={[{ content: answer.content, role: 'assistant' }]}
    />
  );
  const group = await screen.findByTestId('assistant-activity-group');
  expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(1);
  expect(screen.queryByTestId('local-chain-of-thought')).not.toBeInTheDocument();
  // The gap before each `·` segment is CSS, not text.
  expect(within(group).getByTestId('assistant-activity-summary')).toHaveTextContent(
    new RegExp(`^Found files, searched, read 12 files\\s*· ${calls} steps$`)
  );
  expect(await screen.findByText('The siphon tour is complete.')).toBeInTheDocument();
});
