import '@testing-library/jest-dom/vitest';
// Must evaluate before anything that loads React DOM (React DevTools hook).
import './committed-assistant-browser-support';
import recording from '@brainstrike/test-utils/fixtures/committed-host-ended-runs.json';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import {
  type CommittedAssistantLogSource,
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '../committed-assistant-log-store';
import { settleAnimations } from './committed-assistant-browser-support';
import { conversation, Surface } from './committed-conversation-surface';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

/**
 * BST-1982 in real Chromium: the shipped committed conversation over the
 * recorded HostCore runs that ended early (record-ended-log.mjs). Each run's
 * reply keeps its committed text and shows exactly one end marker: its
 * activity trace's own end, or the standalone end row.
 */

const rows: readonly CommittedAssistantLogRow[] = recording;
const TRACE_ENDS = new Set(['Stopped', 'Activity failed']);
const ROW_ENDS = new Set(['Stopped', 'Reply interrupted']);

/** A thread's complete committed log; it never changes. */
class SettledSource implements CommittedAssistantLogSource {
  private readonly snapshot: CommittedAssistantLogSourceSnapshot;
  constructor(threadRows: readonly CommittedAssistantLogRow[]) {
    this.snapshot = { connected: true, error: undefined, rows: threadRows };
  }
  readonly getSnapshot = (): CommittedAssistantLogSourceSnapshot => this.snapshot;
  readonly subscribe = (): (() => void) => () => undefined;
}

async function mountThread(prompt: string) {
  const start = rows.find(
    ({ event }) => event['type'] === 'run.started' && event['prompt'] === prompt
  );
  if (!start) {
    throw new Error(`The recording has no run for "${prompt}".`);
  }
  const threadRows = rows.filter(({ threadId }) => threadId === start.threadId);
  const runIds = threadRows.flatMap(({ event }) =>
    event['type'] === 'run.started' ? [String(event['runId'])] : []
  );
  const store = new CommittedAssistantLogStore({
    // Test-owned resolver: each run answers the run before it in its thread.
    identifyRun: (row) => {
      const id = String(row.event['runId']);
      return {
        assistantMessageId: id,
        createdAt: new Date('2026-10-12T12:00:00.000Z'),
        parentMessageId: runIds[runIds.indexOf(id) - 1] ?? null,
        userMessageId: `user-${id}`,
      };
    },
    source: new SettledSource(threadRows),
    threadId: start.threadId,
  });
  onTestFinished(() => store.dispose());
  render(<Surface actions={{ onNew: vi.fn() }} store={store} />);
  const surface = conversation();
  await surface.ui.findByText(prompt);
  await settleAnimations(surface.region);
  return { runId: String(start.event['runId']), surface };
}

/** The visible end markers of one assistant message. */
function endMarkers(message: Element): string[] {
  const traceEnds = [...message.querySelectorAll('.bs-activity-summary-label')]
    .map((label) => label.textContent?.trim() ?? '')
    .filter((label) => TRACE_ENDS.has(label));
  const rowEnds = [...message.querySelectorAll('[data-testid="assistant-run-timeline"]')]
    .map((row) => row.querySelector('.font-medium')?.textContent?.trim() ?? '')
    .filter((label) => ROW_ENDS.has(label));
  return [...traceEnds.map((end) => `trace:${end}`), ...rowEnds.map((end) => `row:${end}`)];
}

function messageOf(surface: ReturnType<typeof conversation>, runId: string): Element {
  const message = surface.viewport.querySelector(`[data-message-id="${runId}"]`);
  if (!message) {
    throw new Error(`The run ${runId} rendered no message.`);
  }
  return message;
}

describe('a reply that ends early keeps its text and shows one end marker', () => {
  test.each([
    ['Write slowly, then stop.', 'Partial reply before the Stop.', ['row:Stopped']],
    ['Call the probe, then stop.', 'Checking with the probe.', ['trace:Stopped']],
    ['Write slowly, then quit.', 'Partial reply before the quit.', ['row:Reply interrupted']],
    ['Call the probe, then quit.', 'Checking with the probe.', ['trace:Activity failed']],
    ['Write slowly, then crash.', null, ['row:Reply interrupted']],
  ] as const)('%s', async (prompt, kept, markers) => {
    const { runId, surface } = await mountThread(prompt);
    const message = messageOf(surface, runId);
    if (kept) {
      // Assistant text renders through a lazily loaded markdown chunk, with a
      // "Loading message…" placeholder until it lands; whichever row runs first
      // meets it cold. Plain user text renders at once (#3736), so finding the
      // prompt no longer implies the chunk has loaded: await the kept text.
      await waitFor(() => expect(message).toHaveTextContent(kept));
    }
    expect(endMarkers(message)).toEqual(markers);
  });
});
