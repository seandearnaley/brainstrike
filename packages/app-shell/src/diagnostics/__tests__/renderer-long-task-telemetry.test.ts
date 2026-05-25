import { addLogListener, configureLogger, LogLevel, resetLogger } from '@brainstrike/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRendererLongTaskObserver,
  normalizeRendererRoute,
  type RendererLongTaskTelemetryContext,
  recordRendererLongTaskTelemetry,
} from '../renderer-long-task-telemetry';

describe('renderer-long-task-telemetry', () => {
  afterEach(() => {
    resetLogger();
    vi.unstubAllGlobals();
  });

  it('maps navigation paths to coarse route surfaces without retaining raw paths', () => {
    expect(normalizeRendererRoute('/settings')).toBe('settings');
    expect(normalizeRendererRoute('/prompts')).toBe('prompts');
    expect(normalizeRendererRoute('/')).toBe('explorer');
    expect(normalizeRendererRoute('/Users/seandearnaley/private/repo')).toBe('unknown');

    const serialized = JSON.stringify({
      explorer: normalizeRendererRoute('/'),
      settings: normalizeRendererRoute('/settings'),
    });
    expect(serialized).not.toContain('/Users/seandearnaley');
  });

  it('records only coarse long-task metadata', () => {
    configureLogger({ console: false, level: LogLevel.DEBUG });
    const records: unknown[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      recordRendererLongTaskTelemetry({
        durationMs: 84.2,
        event: 'renderer.long-task',
        feature: 'database-panel',
        route: 'explorer',
      });
    } finally {
      unsubscribe();
    }

    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain('renderer.long-task');
    expect(serialized).toContain('database-panel');
    expect(serialized).toContain('84.2');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('secret-plan.md');
  });

  it('observes long tasks and attaches the current route and feature context', () => {
    configureLogger({ console: false, level: LogLevel.DEBUG });
    const records: unknown[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    let callback: PerformanceObserverCallback | null = null;
    class MockPerformanceObserver {
      constructor(nextCallback: PerformanceObserverCallback) {
        callback = nextCallback;
      }

      observe(): void {}

      disconnect(): void {}
    }

    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    const context: RendererLongTaskTelemetryContext = {
      route: 'settings',
      feature: 'preferences-form',
    };

    const dispose = createRendererLongTaskObserver(() => context);

    expect(callback).not.toBeNull();
    callback!(
      {
        getEntries: () => [
          {
            duration: 72,
            entryType: 'longtask',
            name: 'self',
            startTime: 0,
            toJSON: () => ({}),
          } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    dispose();
    unsubscribe();

    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain('renderer.long-task');
    expect(serialized).toContain('settings');
    expect(serialized).toContain('preferences-form');
    expect(serialized).toContain('72');
  });
});
