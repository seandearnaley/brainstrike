import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyDebugBundleButton } from '../assistant-ui-panel/copy-debug-bundle-button';
import {
  type DebugBundleBinding,
  DebugBundleProvider,
} from '../assistant-ui-panel/debug-bundle-context';

const messagePartsMock = vi.hoisted(() => [] as unknown[]);
const messageStatusMock = vi.hoisted(
  () =>
    ({ reason: undefined, type: undefined }) as {
      reason: string | undefined;
      type: string | undefined;
    }
);

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: { message: unknown }) => unknown) =>
    selector({ message: { parts: messagePartsMock, status: messageStatusMock } }),
}));

function runEventPart(data: Record<string, unknown>): Record<string, unknown> {
  return { data, name: 'brainstrike.run-event', type: 'data' };
}

function wrap(binding: DebugBundleBinding | null, ui: ReactNode) {
  return render(<DebugBundleProvider value={binding}>{ui}</DebugBundleProvider>);
}

const clipboardWriteText = vi.fn();

beforeEach(() => {
  messagePartsMock.length = 0;
  messageStatusMock.reason = undefined;
  messageStatusMock.type = undefined;
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue(undefined);
  // jsdom does not implement navigator.clipboard.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
});

describe('CopyDebugBundleButton', () => {
  it('renders nothing without a provider, even with a run.failed part', () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const { container } = render(<CopyDebugBundleButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with a provider but no failure signal', () => {
    const binding: DebugBundleBinding = { buildBundle: vi.fn() };
    const { container } = wrap(binding, <CopyDebugBundleButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is visible with a provider and a run.failed run-event part, and copies the bundle on click', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const bundle = '# BrainStrike Debug Bundle\n\nsome content';
    const buildBundle = vi.fn().mockResolvedValue(bundle);
    wrap({ buildBundle }, <CopyDebugBundleButton />);

    const button = screen.getByTestId('copy-debug-bundle');
    expect(button).toHaveTextContent('Copy debug bundle');

    await userEvent.click(button);

    expect(buildBundle).toHaveBeenCalledWith({ runId: 'run-1' });
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(bundle);
    });
    await waitFor(() => {
      expect(screen.getByTestId('copy-debug-bundle')).toHaveTextContent(/^Copied · \d+ KB$/);
    });
  });

  it('is visible when the message carries assistant-ui error state (no run.failed part)', () => {
    messageStatusMock.reason = 'error';
    messageStatusMock.type = 'incomplete';
    const binding: DebugBundleBinding = { buildBundle: vi.fn() };
    wrap(binding, <CopyDebugBundleButton />);
    expect(screen.getByTestId('copy-debug-bundle')).toBeInTheDocument();
  });

  it('shows a visible error when the binding rejects', async () => {
    messagePartsMock.push(
      runEventPart({ id: 'e1', kind: 'run.failed', runId: 'run-1', status: 'failed' })
    );
    const buildBundle = vi.fn().mockRejectedValue(new Error('db unavailable'));
    wrap({ buildBundle }, <CopyDebugBundleButton />);

    await userEvent.click(screen.getByTestId('copy-debug-bundle'));

    expect(await screen.findByText('Copy failed: db unavailable')).toBeInTheDocument();
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});
