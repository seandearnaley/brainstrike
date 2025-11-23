import { LogLevel, type LogRecord } from '@brainstrike/utils';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LoggingSettingsSection, type LogSourceAdapter } from './logging-settings-section';

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
        level: LogLevel.INFO,
        timestamp: Date.now(),
        args: ['hello world'],
        bindings: {},
        scope: 'TestScope',
        message: 'Renderer log row',
      },
    ];

    render(<LoggingSettingsSection runtime="browser" logSource={createLogSource(sampleRecords)} />);

    await waitFor(() => {
      expect(screen.getByText('Renderer log row')).toBeInTheDocument();
    });
  });

  it('updates when logs arrive via subscribe after mount', async () => {
    const laterRecords: LogRecord[] = [
      {
        level: LogLevel.ERROR,
        timestamp: Date.now() + 1,
        args: ['late log'],
        bindings: {},
        scope: 'LateScope',
        message: 'Late arriving row',
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

    render(<LoggingSettingsSection runtime="browser" logSource={logSource} />);

    await waitFor(
      () => {
        expect(screen.getByText('Late arriving row')).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });
});
