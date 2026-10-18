import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, onTestFinished, test, vi } from 'vitest';
import { AssistantUiPanel } from '../assistant-ui-panel';

/**
 * BST-2185: web's real approval flow. `AssistantUiPanel` is the panel apps/web
 * mounts (`AssistantUiPanelWrapper`), so the runtime here is the one web
 * constructs: `useBrainstrikeDataStreamRuntime` over `useLocalRuntime`, which
 * in @assistant-ui/core 0.3.29 rewrites a paused message to
 * `incomplete/cancelled` once a later message follows it, and also settles it
 * that way when Stop ends the run. Only the route is scripted, with the wire
 * frames the data-stream mapper emits for a pause
 * (`packages/agent/src/__tests__/data-stream-session.spec.ts`).
 *
 * Owner ruling: an approved call shows only its "Approved" card, a declined one
 * its decline, and a pause the user stopped before deciding reads "Stopped: not
 * approved". Never the generic "Stopped · 1 step" for the paused call.
 */

const approval = {
  args: { path: 'package.json' },
  riskCategory: 'read',
  runId: 'native-run',
  toolCallId: 'read-package',
  toolName: 'brainstrike.readWorkspaceFile',
} as const;

const frame = (code: string, value: unknown): string => `${code}:${JSON.stringify(value)}`;

/** The pause, through the approval notice: what the mapper emits before it finishes the leg. */
const PAUSE_FRAMES = [
  frame('f', { messageId: 'paused-leg' }),
  frame('b', { toolCallId: approval.toolCallId, toolName: approval.toolName }),
  frame('c', { argsTextDelta: JSON.stringify(approval.args), toolCallId: approval.toolCallId }),
  frame('9', { args: approval.args, toolCallId: approval.toolCallId, toolName: approval.toolName }),
  frame('aui-data', { data: approval, name: 'brainstrike.tool-approval' }),
];

/** A paused leg ends with a zero-usage `tool-calls` finish. */
const PAUSE_FINISH_FRAMES = [
  frame('e', { finishReason: 'tool-calls', usage: { completionTokens: 0, promptTokens: 0 } }),
  frame('d', { finishReason: 'tool-calls', path: [], usage: { inputTokens: 0, outputTokens: 0 } }),
];

const STOP_FINISH_FRAMES = [
  frame('e', { finishReason: 'stop', usage: { completionTokens: 1, promptTokens: 1 } }),
  frame('d', { finishReason: 'stop', path: [], usage: { inputTokens: 1, outputTokens: 1 } }),
];

function answeredFrame(decision: 'approve' | 'decline'): string {
  return frame('aui-data', {
    data: { ...approval, decision, reason: 'user' },
    name: 'brainstrike.tool-approval-answered',
  });
}

interface ScriptedLeg {
  readonly body: Record<string, unknown>;
  readonly close: () => void;
  readonly push: (...frames: readonly string[]) => void;
}

/** One scripted response stream per POST to the web assistant route, as a real fetch behaves. */
function scriptAssistantRoute() {
  const legs: ScriptedLeg[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      // Aborting the request errors its response body, as with real fetch.
      init?.signal?.addEventListener(
        'abort',
        () => {
          if (!ended) {
            ended = true;
            controller?.error(new DOMException('The user aborted a request.', 'AbortError'));
          }
        },
        { once: true }
      );
      legs.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        close: () => {
          if (!ended) {
            ended = true;
            controller?.close();
          }
        },
        push: (...frames) => {
          controller?.enqueue(encoder.encode(`${frames.join('\n')}\n`));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    })
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return {
    async leg(index: number): Promise<ScriptedLeg> {
      await waitFor(() => expect(legs.length).toBeGreaterThan(index));
      const leg = legs[index];
      if (!leg) {
        throw new Error(`Missing assistant route leg ${index}`);
      }
      return leg;
    },
  };
}

function renderWebPanel() {
  render(
    <TooltipProvider>
      <div style={{ height: 720, width: 760 }}>
        <AssistantUiPanel pickerModels={[]} pickerProviders={[]} threadKey="web-approval-thread" />
      </div>
    </TooltipProvider>
  );
}

async function sendPrompt(): Promise<void> {
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Message input' }),
    'Read package.json{Enter}'
  );
}

/** The assistant message that carries the pause's approval notice. */
function pausedTurn(): HTMLElement {
  const notice = screen.getByTestId('assistant-tool-approval-notice');
  const turn = notice.closest<HTMLElement>('.aui-assistant-message-root');
  if (!turn) {
    throw new Error('The approval notice is not inside an assistant message.');
  }
  return turn;
}

async function pauseForApproval(route: ReturnType<typeof scriptAssistantRoute>) {
  await sendPrompt();
  const leg = await route.leg(0);
  leg.push(...PAUSE_FRAMES, ...PAUSE_FINISH_FRAMES);
  leg.close();
  await screen.findByRole('button', { name: `Approve ${approval.toolName}` });
  // The live pause: the card owns the call, so no activity group duplicates it.
  expect(within(pausedTurn()).queryByTestId('assistant-activity-group')).toBeNull();
}

test('A: approving a paused call leaves only the Approved card on the paused turn', async () => {
  const route = scriptAssistantRoute();
  renderWebPanel();
  await pauseForApproval(route);

  await userEvent.click(screen.getByRole('button', { name: `Approve ${approval.toolName}` }));
  const resumed = await route.leg(1);
  expect(resumed.body).toMatchObject({
    runConfig: {
      custom: { brainstrikeToolApproval: { action: 'approve', toolCallId: approval.toolCallId } },
    },
  });
  resumed.push(
    frame('f', { messageId: 'resumed-leg' }),
    answeredFrame('approve'),
    frame('9', {
      args: approval.args,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
    }),
    frame('a', { result: { content: '{"name":"brainstrike"}' }, toolCallId: approval.toolCallId }),
    frame('0', 'The package has been read.'),
    ...STOP_FINISH_FRAMES
  );
  resumed.close();

  const reply = await screen.findByText('The package has been read.');
  await waitFor(() =>
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Approved')
  );
  const paused = pausedTurn();
  expect(within(paused).queryByTestId('assistant-activity-group')).toBeNull();
  expect(within(paused).queryByText(/Stopped/)).toBeNull();
  // The call ran in the resumed turn, which owns its result.
  const resumedTurn = reply.closest<HTMLElement>('.aui-assistant-message-root');
  expect(resumedTurn).not.toBe(paused);
  expect(within(resumedTurn as HTMLElement).getByTestId('assistant-activity-group')).toBeTruthy();
});

test('C: declining a paused call leaves only its Declined card on the paused turn', async () => {
  const route = scriptAssistantRoute();
  renderWebPanel();
  await pauseForApproval(route);

  await userEvent.click(screen.getByRole('button', { name: `Decline ${approval.toolName}` }));
  const resumed = await route.leg(1);
  expect(resumed.body).toMatchObject({
    runConfig: {
      custom: { brainstrikeToolApproval: { action: 'decline', toolCallId: approval.toolCallId } },
    },
  });
  resumed.push(
    frame('f', { messageId: 'resumed-leg' }),
    answeredFrame('decline'),
    frame('0', 'I will not read the package.'),
    ...STOP_FINISH_FRAMES
  );
  resumed.close();

  await screen.findByText('I will not read the package.');
  await waitFor(() =>
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Declined')
  );
  const paused = pausedTurn();
  expect(within(paused).queryByTestId('assistant-activity-group')).toBeNull();
  expect(within(paused).queryByText(/Stopped/)).toBeNull();
});

test('B: Stop while an approval is pending reads "Stopped: not approved" on the card', async () => {
  const route = scriptAssistantRoute();
  renderWebPanel();
  await sendPrompt();
  const leg = await route.leg(0);
  // The run is still live while its approval waits.
  leg.push(...PAUSE_FRAMES);
  await screen.findByRole('button', { name: `Approve ${approval.toolName}` });

  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

  await waitFor(() =>
    expect(within(pausedTurn()).getByTestId('approval-row-status')).toHaveTextContent(
      'Stopped: not approved'
    )
  );
  const paused = pausedTurn();
  expect(within(paused).queryByTestId('assistant-activity-group')).toBeNull();
  expect(screen.queryByRole('button', { name: `Approve ${approval.toolName}` })).toBeNull();
  expect(screen.queryByRole('button', { name: `Decline ${approval.toolName}` })).toBeNull();
});
