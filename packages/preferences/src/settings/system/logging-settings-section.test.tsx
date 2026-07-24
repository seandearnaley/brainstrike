import { LogLevel, type LogRecord } from '@brainstrike/utils';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LoggingSettingsSection, type LogSourceAdapter } from './logging-settings-section';

// Mock virtualizer to render all items for testing
vi.mock('@tanstack/react-virtual', async () => {
  const actual = await vi.importActual('@tanstack/react-virtual');
  return {
    ...actual,
    useVirtualizer: ({ count }: any) => ({
      getTotalSize: () => count * 30,
      getVirtualItems: () =>
        Array.from({ length: count }).map((_, i) => ({
          end: (i + 1) * 30,
          index: i,
          key: i,
          measureElement: () => {},
          size: 30,
          start: i * 30,
        })),
      measureElement: () => {},
      scrollToIndex: () => {},
    }),
  };
});

beforeAll(() => {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserver as unknown as typeof ResizeObserver;
  // JSDOM implements neither of these Radix `Select` interaction APIs.
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

function createLogSource(records: readonly LogRecord[]): LogSourceAdapter {
  return {
    getInitialRecords: async () => records,
    subscribe: (handler) => {
      handler(records);
      return vi.fn();
    },
  };
}

/** Same shape as `createLogSource`, but counts `subscribe` calls so a test
 * can observe which adapter the viewer actually subscribed to. */
function createCountingLogSource(records: readonly LogRecord[]): {
  callCount: { subscribe: number };
  source: LogSourceAdapter;
} {
  const callCount = { subscribe: 0 };
  const source: LogSourceAdapter = {
    getInitialRecords: async () => records,
    subscribe: (handler) => {
      callCount.subscribe += 1;
      handler(records);
      return vi.fn();
    },
  };
  return { callCount, source };
}

describe('LoggingSettingsSection log viewer', () => {
  it('renders renderer log records', async () => {
    const sampleRecords: LogRecord[] = [
      {
        args: ['hello world'],
        bindings: {},
        level: LogLevel.INFO,
        message: 'Renderer log row',
        scope: 'TestScope',
        timestamp: Date.now(),
      },
    ];

    render(<LoggingSettingsSection logSource={createLogSource(sampleRecords)} runtime="browser" />);

    await waitFor(() => {
      expect(screen.getByText('Renderer log row')).toBeInTheDocument();
    });
  });

  it('updates when logs arrive via subscribe after mount', async () => {
    const laterRecords: LogRecord[] = [
      {
        args: ['late log'],
        bindings: {},
        level: LogLevel.ERROR,
        message: 'Late arriving row',
        scope: 'LateScope',
        timestamp: Date.now() + 1,
      },
    ];

    const logSource: LogSourceAdapter = {
      getInitialRecords: async () => [],
      subscribe: (handler) => {
        handler([]);
        // Use microtask to ensure update happens after mount but reliably
        Promise.resolve().then(() => handler(laterRecords));
        return vi.fn();
      },
    };

    render(<LoggingSettingsSection logSource={logSource} runtime="browser" />);

    await waitFor(
      () => {
        expect(screen.getByText('Late arriving row')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });
});

describe('LoggingSettingsSection log source switch', () => {
  it('does not render a log source control without a durable source', () => {
    render(<LoggingSettingsSection logSource={createLogSource([])} runtime="browser" />);

    expect(screen.queryByRole('combobox', { name: /log source/i })).not.toBeInTheDocument();
  });

  it('subscribes to the session adapter by default and the durable adapter once Persistent errors is selected', async () => {
    const user = userEvent.setup();
    const session = createCountingLogSource([]);
    const persistent = createCountingLogSource([]);

    render(
      <LoggingSettingsSection
        durableLogSource={persistent.source}
        logSource={session.source}
        runtime="browser"
      />
    );

    await waitFor(() => {
      expect(session.callCount.subscribe).toBeGreaterThan(0);
    });
    expect(persistent.callCount.subscribe).toBe(0);

    await user.click(screen.getByRole('combobox', { name: /log source/i }));
    await user.click(screen.getByText('Persistent errors'));

    await waitFor(() => {
      expect(persistent.callCount.subscribe).toBeGreaterThan(0);
    });
  });

  it('shows the durable empty-state copy once Persistent errors is selected', async () => {
    const user = userEvent.setup();

    render(
      <LoggingSettingsSection
        durableLogSource={createLogSource([])}
        logSource={createLogSource([])}
        runtime="browser"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('No logs recorded for the current session.')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('combobox', { name: /log source/i }));
    await user.click(screen.getByText('Persistent errors'));

    await waitFor(() => {
      expect(screen.getByText('No durable warn+ events recorded.')).toBeInTheDocument();
    });
  });
});
