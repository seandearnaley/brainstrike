import {
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import { act, fireEvent, getConfig, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import '@brainstrike/ui/globals.css';
import '../overrides.css';

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
        {/* The component browser lane does not compile Tailwind utilities.
            Match the panel's h-full host constraint, as the application does. */}
        <style>{'.assistant-ui-panel { height: 100%; }'}</style>
        <AssistantConversationPanel label="Cedar" runtime={runtime} threadKey="child" />
      </div>
    </TooltipProvider>
  );
}

afterEach(async () => {
  await commands.emulateReducedMotion({ enabled: null });
});

test.each(
  [390, 900].flatMap((width) =>
    [false, true].flatMap((dark) =>
      [false, true].map((reducedMotion) => ({ dark, reducedMotion, width }))
    )
  )
)(
  'keeps the shared long child transcript bounded and composer reachable ($width / dark=$dark / reduced=$reducedMotion)',
  async ({ width, dark, reducedMotion }) => {
    await commands.emulateReducedMotion({ enabled: reducedMotion });
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(reducedMotion);
    render(<Child dark={dark} width={width} />);
    const panel = screen.getByRole('region', { name: 'Cedar' });
    const child = within(panel);
    const viewport = child.getByTestId('assistant-ui-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-thread-render-tier', 'virtual'));
    await waitFor(() => expect(child.getByText(/Evidence 599:/)).toBeVisible());
    expect(panel.querySelectorAll('.bs-virtual-message').length).toBeLessThan(40);
    const bounds = panel.getBoundingClientRect();
    const input = child.getByRole('textbox', { name: 'Message input' });
    const composer = child.getByTestId('assistant-composer-shell').getBoundingClientRect();
    expect(composer.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    expect(composer.left).toBeGreaterThanOrEqual(bounds.left);
    expect(composer.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    await act(async () => input.focus());
    expect(input).toHaveFocus();
    await waitFor(() =>
      expect(
        Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
      ).toBeLessThanOrEqual(2)
    );
    // Native scrollToIndex seals its initial instant landing on the next
    // animation frame. Let that frame complete before simulating a new scroll.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    viewport.scrollTo({ behavior: 'instant', top: 0 });
    fireEvent.scroll(viewport);
    await waitFor(() => expect(child.getByText(/Evidence 0:/)).toBeVisible());
    const jump = child.getByRole('button', { name: 'Scroll to latest messages' });
    await waitFor(() => expect(jump).toBeEnabled());
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
    await waitFor(() => expect(jump).toBeDisabled());
  }
);

// Keep the Playwright provider's Node/Electron type augmentation in the
// Vitest config, outside the DOM test program. This is a real media override.
declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateReducedMotion: (options: { enabled: boolean | null }) => Promise<void>;
  }
}
