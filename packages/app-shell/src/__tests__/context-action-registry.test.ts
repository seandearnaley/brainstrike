import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppActionRegistry } from '../context-action-registry';

type MutableWindow = Window & { platform?: unknown };

afterEach(() => {
  (window as MutableWindow).platform = undefined;
  resetLogger();
  vi.restoreAllMocks();
});

describe('createAppActionRegistry', () => {
  it('grants only clipboard on web (no window.platform)', () => {
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('clipboard')).toBe(true);
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
  });

  it('grants fs capabilities when window.platform is fully formed', () => {
    (window as MutableWindow).platform = {
      openPath: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(true);
    expect(registry.capabilities.has('fs.openPath')).toBe(true);
    expect(registry.services.platformFs).toBeDefined();
  });

  it('treats a malformed bridge as absent (and the actions stay hidden)', () => {
    configureLogger({ console: false });
    (window as MutableWindow).platform = { showItemInFolder: vi.fn() };
    const registry = createAppActionRegistry();
    expect(registry.capabilities.has('fs.reveal')).toBe(false);
    expect(registry.services.platformFs).toBeUndefined();
  });

  it('logs an error when the bridge is malformed', () => {
    configureLogger({ console: false });
    (window as MutableWindow).platform = { openPath: vi.fn() };
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      createAppActionRegistry();
    } finally {
      unsubscribe();
    }

    const malformedRecord = records.find(
      (record) =>
        record.scope === 'ContextActionRegistry' &&
        record.message?.includes('window.platform bridge is malformed')
    );
    expect(malformedRecord).toBeDefined();
    expect(malformedRecord?.args).toContainEqual({
      hasOpenPath: true,
      hasShowItemInFolder: false,
    });
  });

  it('includes the composed global actions', () => {
    const registry = createAppActionRegistry();
    const grouped = registry.actionsFor({ kind: 'chunk', id: 'c', content: 'x' });
    const flatIds = grouped.flatMap((group) => group.actions.map((action) => action.id));
    expect(flatIds).toContain('collection.copy-id');
    expect(flatIds).toContain('collection.copy-content');
  });
});
