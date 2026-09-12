import {
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { act, fireEvent, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import type { SendActiveConversationInput } from '../active-conversation-input-context';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

const onNew = (_message: AppendMessage): Promise<void> => {
  throw new Error('Viewing a child cannot invoke a model');
};
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;
const messages: readonly ThreadMessageLike[] = Array.from({ length: 600 }, (_, index) => ({
  content: [
    { text: `Evidence ${index}: the child conversation uses the shared renderer.`, type: 'text' },
  ],
  id: `child-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
}));

function Child({ width, dark }: { width: number; dark: boolean }) {
  const runtime = useExternalStoreRuntime({ convertMessage, messages, onNew });
  return (
    <TooltipProvider>
      <div className={dark ? 'dark' : undefined} style={{ height: 620, width }}>
        <AssistantConversationPanel label="Cedar" runtime={runtime} threadKey="child" />
      </div>
    </TooltipProvider>
  );
}

afterEach(async () => {
  await commands.emulateReducedMotion({ enabled: null });
});

// Keep geometry changes rather than every frame. A failure must preserve the
// resize/scroll sequence that led to its gap, not only the final screenshot.
function recordOpeningGeometry(viewport: HTMLElement): { read: () => string; stop: () => void } {
  const changes: { elapsedMs: number; geometry: string }[] = [];
  const started = performance.now();
  let previous = '';
  let frame = 0;
  const sample = (): void => {
    const geometry = JSON.stringify({
      clientHeight: viewport.clientHeight,
      rows: Array.from(viewport.querySelectorAll<HTMLElement>('.bs-virtual-message'), (row) => ({
        height: row.getBoundingClientRect().height,
        index: row.dataset['index'],
        loading: row.querySelector('.animate-pulse') !== null,
        transform: row.style.transform,
      })),
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    });
    if (geometry !== previous) {
      changes.push({ elapsedMs: Math.round(performance.now() - started), geometry });
      if (changes.length > 64) {
        changes.shift();
      }
      previous = geometry;
    }
    frame = requestAnimationFrame(sample);
  };
  sample();
  const stop = (): void => cancelAnimationFrame(frame);
  onTestFinished(stop);
  return { read: () => JSON.stringify(changes), stop };
}

test.each(
  [390, 900].flatMap((width) =>
    [false, true].flatMap((dark) =>
      [false, true].map((reducedMotion) => ({ dark, reducedMotion, width }))
    )
  )
)(
  'keeps the shared long child transcript bounded and composer reachable ($width / dark=$dark / reduced=$reducedMotion)',
  async ({ width, dark, reducedMotion }) => {
    const previousViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(width, 800);
    onTestFinished(() => page.viewport(previousViewport.width, previousViewport.height));
    expect(window.innerWidth).toBe(width);
    await commands.emulateReducedMotion({ enabled: reducedMotion });
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(reducedMotion);
    render(<Child dark={dark} width={width} />);
    const panel = screen.getByRole('region', { name: 'Cedar' });
    const child = within(panel);
    const viewport = child.getByTestId('assistant-ui-viewport');
    const openingGeometry = recordOpeningGeometry(viewport);
    const openingEnded = vi.fn();
    viewport.addEventListener('scrollend', openingEnded, { once: true });
    onTestFinished(() => viewport.removeEventListener('scrollend', openingEnded));
    await waitFor(() => expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual'));
    expect(getComputedStyle(viewport).scrollBehavior).toBe('auto');
    await waitFor(() => expect(child.getByText(/Evidence 599:/)).toBeVisible());
    const lastMessage = child.getByText(/Evidence 599:/).closest('.aui-assistant-message-root');
    if (!lastMessage) {
      throw new Error('Expected the shared assistant message root');
    }
    expect(getComputedStyle(lastMessage).display).toBe('grid');
    expect(panel.querySelectorAll('.bs-virtual-message').length).toBeLessThan(40);
    const bounds = panel.getBoundingClientRect();
    const input = child.getByRole('textbox', { name: 'Message input' });
    const composer = child.getByTestId('assistant-composer-shell').getBoundingClientRect();
    expect(composer.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    expect(composer.left).toBeGreaterThanOrEqual(bounds.left);
    expect(composer.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(composer.top).toBeGreaterThanOrEqual(0);
    expect(composer.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(composer.right).toBeLessThanOrEqual(window.innerWidth);
    const inputBounds = input.getBoundingClientRect();
    expect(input).toBeVisible();
    expect(
      input.contains(
        document.elementFromPoint(
          inputBounds.x + inputBounds.width / 2,
          inputBounds.y + inputBounds.height / 2
        )
      )
    ).toBe(true);

    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await act(async () => input.focus());
    expect(input).toHaveFocus();
    await waitFor(
      () =>
        expect(
          Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
        ).toBeLessThanOrEqual(2),
      {
        onTimeout: (error) =>
          new Error(`${error.message}\nOpening scroll geometry: ${openingGeometry.read()}`, {
            cause: error,
          }),
      }
    );
    // A momentary bottom position or one animation frame does not establish
    // native completion while lazy rows are still being measured. Match the
    // virtualizer regression's scrollend boundary before starting a new gesture.
    await waitFor(() => expect(openingEnded).toHaveBeenCalled());
    act(() => {
      viewport.scrollTo({ behavior: 'instant', top: 0 });
      fireEvent.scroll(viewport);
    });
    await waitFor(() => expect(child.getByText(/Evidence 0:/)).toBeVisible(), {
      onTimeout: (error) =>
        new Error(`${error.message}\nScroll geometry: ${openingGeometry.read()}`, { cause: error }),
    });
    // Record through jump completion too: the final affordance is a layout assertion.
    const jump = child.getByRole('button', { name: 'Scroll to latest messages' });
    await waitFor(() => expect(jump).toBeEnabled());
    const jumpBounds = jump.getBoundingClientRect();
    expect(jump).toBeVisible();
    expect(jumpBounds.top).toBeGreaterThanOrEqual(0);
    expect(jumpBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(jumpBounds.left).toBeGreaterThanOrEqual(0);
    expect(jumpBounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(
      jump.contains(
        document.elementFromPoint(
          jumpBounds.x + jumpBounds.width / 2,
          jumpBounds.y + jumpBounds.height / 2
        )
      )
    ).toBe(true);

    await act(async () => {
      jump.focus();
      await userEvent.keyboard('{Enter}');
    });
    // A 600-row smooth jump measured ~1.6s locally. Match the existing
    // virtualization suite's frame/measurement settling budget, and require
    // the true bottom plus the final row, not merely a completed animation.
    await waitFor(
      () => {
        expect(child.getByText(/Evidence 599:/)).toBeVisible();
        expect(
          Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
        ).toBeLessThanOrEqual(2);
      },
      { timeout: Math.max(5000, getConfig().asyncUtilTimeout) }
    );
    await waitFor(() => expect(jump).toBeDisabled(), {
      onTimeout: (error) =>
        new Error(`${error.message}\nJump geometry: ${openingGeometry.read()}`, { cause: error }),
    });
    openingGeometry.stop();
  }
);

// Keep the Playwright provider's Node/Electron type augmentation in the
// Vitest config, outside the DOM test program. This is a real media override.
declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateReducedMotion: (options: { enabled: boolean | null }) => Promise<void>;
  }
}

test('commits virtual sizing synchronously under reduced motion', async () => {
  await commands.emulateReducedMotion({ enabled: true });
  render(<Child dark width={390} />);
  const viewport = within(screen.getByRole('region', { name: 'Cedar' })).getByTestId(
    'assistant-ui-viewport'
  );
  await waitFor(() => expect(within(viewport).getByText(/Evidence 599:/)).toBeVisible());
  const sizer = viewport.querySelector<HTMLElement>('.bs-virtual-thread');
  if (!sizer) {
    throw new Error('Missing virtual sizing container');
  }
  const height = sizer.getBoundingClientRect().height;
  const previous = sizer.style.height;
  // The vendor writes and reads geometry in the same ResizeObserver callback.
  // A nonzero transition duration on the default property `all` defers this
  // measurement to another frame, even at the reduced-motion duration 0.01ms.
  try {
    sizer.style.height = `${height + 400}px`;
    expect(sizer.getBoundingClientRect().height).toBe(height + 400);
  } finally {
    sizer.style.height = previous;
  }
});

function ChildInputReceipt({
  running,
  width,
  send,
  append,
}: {
  readonly running: boolean;
  readonly width: number;
  readonly send: SendActiveConversationInput;
  readonly append: (message: AppendMessage) => Promise<void>;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage,
    isRunning: running,
    messages: messages.slice(0, 2),
    onNew: append,
  });
  return (
    <TooltipProvider>
      <div style={{ height: 620, width }}>
        <AssistantConversationPanel
          label="Cedar input receipt"
          onSendActiveInput={send}
          runtime={runtime}
          threadKey="child-input-receipt"
        />
      </div>
    </TooltipProvider>
  );
}

test.each([390, 900])(
  'retains pending child input controls after idle without replay at width %s',
  async (width) => {
    const previousViewport = { height: window.innerHeight, width: window.innerWidth };
    await page.viewport(width, 800);
    onTestFinished(() => page.viewport(previousViewport.width, previousViewport.height));
    expect(window.innerWidth).toBe(width);
    const accepted = Promise.withResolvers<void>();
    let transportSettled = false;
    const send = vi.fn(async () => {
      await accepted.promise;
      transportSettled = true;
    });
    const append = vi.fn(async (_message: AppendMessage) => {});
    const view = (running: boolean) => (
      <ChildInputReceipt append={append} running={running} send={send} width={width} />
    );
    const { rerender } = render(view(true));
    const panel = screen.getByRole('region', { name: 'Cedar input receipt' });
    const child = within(panel);
    const input = child.getByRole('textbox', { name: 'Message input' });
    await act(async () => {
      await userEvent.fill(input, 'Possibly delivered');
    });
    await act(async () => {
      await userEvent.click(child.getByRole('button', { name: 'Send to child' }));
    });
    rerender(view(false));
    expect(child.getByText('Sending to child…')).toBeVisible();
    expect(child.getByRole('button', { name: 'Send' })).toBeDisabled();
    const stop = child.getByRole('button', { name: 'Stop waiting' });
    const panelBounds = panel.getBoundingClientRect();
    const stopBounds = stop.getBoundingClientRect();
    expect(stop).toBeVisible();
    expect(
      stop.contains(
        document.elementFromPoint(
          stopBounds.x + stopBounds.width / 2,
          stopBounds.y + stopBounds.height / 2
        )
      )
    ).toBe(true);
    expect(stopBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom + 1);
    expect(stopBounds.right).toBeLessThanOrEqual(panelBounds.right + 1);
    await act(async () => {
      await userEvent.click(stop);
    });
    expect(child.getByTestId('child-input-delivery')).toHaveTextContent('Delivery is unconfirmed');
    expect(input).toHaveValue('Possibly delivered');
    expect(child.getByRole('button', { name: 'Send' })).toBeDisabled();
    await act(async () => {
      await userEvent.click(input);
    });
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(send).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    const discard = child.getByRole('button', { name: 'Discard draft' });
    const discardBounds = discard.getBoundingClientRect();
    expect(discardBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom + 1);
    expect(discard).toBeVisible();
    expect(
      discard.contains(
        document.elementFromPoint(
          discardBounds.x + discardBounds.width / 2,
          discardBounds.y + discardBounds.height / 2
        )
      )
    ).toBe(true);
    await act(async () => {
      await userEvent.click(discard);
    });
    expect(input).toHaveValue('');
    expect(child.queryByTestId('child-input-delivery')).not.toBeInTheDocument();
    await act(async () => {
      accepted.resolve();
      await accepted.promise;
    });
    expect(transportSettled).toBe(true);
    expect(input).toHaveValue('');
    expect(send).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  }
);
