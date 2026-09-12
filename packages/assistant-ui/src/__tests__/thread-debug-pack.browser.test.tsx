import { type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@brainstrike/ui';
import type { FileExportsBridge } from '@brainstrike/utils/browser-download';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { DebugBundleProvider } from '../debug-bundle-context';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';

const messages: ThreadMessageLike[] = [
  {
    content: [{ text: 'Completed successfully.', type: 'text' }],
    id: 'success',
    role: 'assistant',
  },
];
function Conversation({
  width,
  buildThreadPack,
}: {
  width: number;
  buildThreadPack: () => Promise<string>;
}) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    messages,
    onNew: async () => {
      throw new Error('Export must never run a model');
    },
  });
  return (
    <TooltipProvider>
      <DebugBundleProvider value={{ buildBundle: async () => '', buildThreadPack }}>
        <div style={{ height: 620, width }}>
          <AssistantConversationPanel
            label="Successful conversation"
            runtime={runtime}
            threadKey="root"
          />
        </div>
      </DebugBundleProvider>
    </TooltipProvider>
  );
}

test.each([390, 900])(
  'exports a successful conversation at %ipx through the real download helper',
  async (width) => {
    await page.viewport(width, 800);
    const original = Object.getOwnPropertyDescriptor(window, 'fileExports');
    const save = vi
      .fn<FileExportsBridge['saveToDownloads']>()
      .mockResolvedValue({ ok: true, path: '/Downloads/debug.json' });
    Object.defineProperty(window, 'fileExports', {
      configurable: true,
      value: { saveToDownloads: save },
    });
    onTestFinished(() => {
      if (original) {
        Object.defineProperty(window, 'fileExports', original);
      } else {
        Reflect.deleteProperty(window, 'fileExports');
      }
    });
    const buildThreadPack = vi
      .fn()
      .mockResolvedValue('{"version":1,"sections":{"messages":["successful"]}}');
    render(<Conversation buildThreadPack={buildThreadPack} width={width} />);
    expect(screen.getByRole('region', { name: 'Successful conversation' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Completed successfully.')).toBeVisible());
    await page.getByText('Debug pack', { exact: true }).click();
    expect(screen.getByText(/Includes this conversation and its subagents/)).toBeVisible();
    await act(async () => {
      await page.getByRole('button', { exact: true, name: 'Download debug pack' }).click();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0]?.[0];
    expect(payload?.filename).toMatch(/^brainstrike-thread-debug-.*\.json$/);
    expect(JSON.parse(new TextDecoder().decode(payload?.bytes)).sections.messages).toEqual([
      'successful',
    ]);
    expect(screen.getByText('Debug pack saved. Review before sharing.')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await act(async () => {
      await page.getByRole('button', { exact: true, name: 'Download debug pack' }).click();
    });
    await waitFor(() => expect(buildThreadPack).toHaveBeenCalledTimes(2));
  }
);
