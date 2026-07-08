import { LogLevel, type LogRecord } from '@brainstrike/utils';
import { render, screen, waitFor } from '@testing-library/react';
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
