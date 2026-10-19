// @boundaries-ignore Browser fixture compiles the consuming app's actual Tailwind/theme pipeline.
import '../../../../apps/web/src/app/globals.css';
import {
  type ChatModelAdapter,
  type ThreadMessageLike,
  useLocalRuntime,
} from '@assistant-ui/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  TooltipProvider,
} from '@brainstrike/ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, onTestFinished, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { preloadMarkdownText } from '../assistant-message-text';

const idle: ChatModelAdapter = {
  run: () => Promise.resolve({ content: [], status: { reason: 'stop', type: 'complete' } }),
};
const messages: readonly ThreadMessageLike[] = Array.from({ length: 16 }, (_, index) => ({
  content: [
    {
      text: `Message ${index}. A shared conversation keeps its composer and transcript readable.`,
      type: 'text',
    },
  ],
  id: `style-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
}));

function Conversation({ width }: { width: number }) {
  const runtime = useLocalRuntime(idle, { initialMessages: messages });
  return (
    <TooltipProvider>
      <div style={{ height: 620, width }}>
        <AssistantConversationPanel
          allowIdleInput
          label="Style parity"
          runtime={runtime}
          threadKey="style-parity"
        />
      </div>
    </TooltipProvider>
  );
}

function element(selector: string): HTMLElement {
  const found = screen
    .getByRole('region', { name: 'Style parity' })
    .querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`Missing conversation element: ${selector}`);
  }
  return found;
}

afterEach(cleanup);

test.each([390, 900].flatMap((width) => [false, true].map((dark) => ({ dark, width }))))(
  'preserves owned chat geometry and theme at $width px / dark=$dark',
  async ({ dark, width }) => {
    const previous = { height: window.innerHeight, width: window.innerWidth };
    const wasDark = document.documentElement.classList.contains('dark');
    onTestFinished(async () => {
      document.documentElement.classList.toggle('dark', wasDark);
      await page.viewport(previous.width, previous.height);
    });
    await page.viewport(width, 800);
    document.documentElement.classList.toggle('dark', dark);
    await preloadMarkdownText();
    render(<Conversation width={width} />);
    const root = element('.bs-thread');
    const viewport = element('.aui-thread-viewport');
    const composer = element('.aui-composer-root');
    const input = element('.aui-composer-input');
    const user = element('[data-message-id="style-14"]');
    const bubble = element('.aui-user-message-content');
    const assistant = element('.aui-assistant-message-root');
    const content = element('.aui-assistant-message-content');
    await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    await document.fonts.ready;
    const rootStyle = getComputedStyle(root);
    const viewportStyle = getComputedStyle(viewport);
    const inputStyle = getComputedStyle(input);
    const contentStyle = getComputedStyle(content);
    const metrics = {
      assistantPadding: getComputedStyle(assistant).paddingTop,
      bubbleBackground: getComputedStyle(bubble).backgroundColor,
      bubblePadding: getComputedStyle(bubble).paddingTop,
      bubbleRadius: getComputedStyle(bubble).borderRadius,
      composerWidth: composer.getBoundingClientRect().width,
      contentPadding: contentStyle.paddingLeft,
      foreground: rootStyle.color,
      gap: rootStyle.gap,
      inputWidth: input.getBoundingClientRect().width,
      panelWidth: root.getBoundingClientRect().width,
      rootBackground: rootStyle.backgroundColor,
      userBottomPadding: getComputedStyle(user).paddingBottom,
      userColumns: getComputedStyle(user).gridTemplateColumns,
      userPadding: getComputedStyle(user).paddingLeft,
      viewportDisplay: viewportStyle.display,
      viewportPadding: viewportStyle.paddingLeft,
    };
    console.info('chat-style-parity', JSON.stringify({ dark, metrics, width }));
    expect(root.getBoundingClientRect().height).toBe(620);
    expect(metrics.panelWidth).toBe(width);
    expect(metrics.gap).toBe('4px');
    expect(metrics.viewportDisplay).toBe('flex');
    expect(viewportStyle.flexDirection).toBe('column');
    expect(viewportStyle.position).toBe('relative');
    expect(metrics.viewportPadding).toBe('16px');
    expect(viewportStyle.paddingTop).toBe('16px');
    expect(metrics.userPadding).toBe('8px');
    expect(metrics.userBottomPadding).toBe('12px');
    expect(metrics.bubblePadding).toBe('10px');
    if (width === 390) {
      expect(metrics.userColumns.split(' ')[0]).toBe('72px');
    }
    expect(metrics.contentPadding).toBe('8px');
    expect(metrics.assistantPadding).toBe('12px');
    expect(inputStyle.minHeight).toBe('48px');
    expect(inputStyle.resize).toBe('none');
    expect(metrics.inputWidth).toBeGreaterThan(width - 135);
    expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(620);
    expect(getComputedStyle(user).color).toBe(rootStyle.color);
    expect(contentStyle.color).toBe(rootStyle.color);
    expect(rootStyle.backgroundColor).toBe(getComputedStyle(document.body).backgroundColor);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getBoundingClientRect().width).toBe(32);
    expect(send.getBoundingClientRect().height).toBe(32);
    await userEvent.click(input);
    expect(document.activeElement).toBe(input);
  }
);

test('keeps shared dialog animation utilities after retiring the vendor stylesheet', () => {
  render(
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Animation contract</DialogTitle>
        <DialogDescription>The app owns its animation stylesheet.</DialogDescription>
      </DialogContent>
    </Dialog>
  );
  expect(
    getComputedStyle(screen.getByRole('dialog', { name: 'Animation contract' })).animationName
  ).toBe('enter');
});
