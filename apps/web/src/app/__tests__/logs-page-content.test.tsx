import type { LogRecord } from '@brainstrike/logging';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWebLogBuffer } from '../../log-buffer';
import { LogsPageContent } from '../logs-page-content';

interface CapturedLogsProps {
  readonly durableLogSource?: unknown;
  readonly logSource: {
    getInitialRecords: () => Promise<readonly LogRecord[]>;
    subscribe: (handler: (records: readonly LogRecord[]) => void) => () => void;
  };
}

const captured = vi.hoisted(() => ({ props: null as CapturedLogsProps | null }));

vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  LogsWorkspacePage: (props: CapturedLogsProps) => {
    captured.props = props;
    return null;
  },
  useDiagnosticSinkHealthStore: () => null,
  useDurableLogSource: () => undefined,
}));

describe('web Logs tab (BST-1791)', () => {
  beforeEach(() => {
    captured.props = null;
    getWebLogBuffer().clear();
  });

  it("reads this tab's log buffer, and offers no durable source without a database", async () => {
    getWebLogBuffer().push({
      args: [],
      bindings: {},
      level: 'warn' as LogRecord['level'],
      message: 'web buffer record',
      scope: 'LogsTabTest',
      timestamp: 1,
    });

    render(<LogsPageContent />);

    const props = captured.props;
    expect(props).not.toBeNull();
    expect(props).not.toHaveProperty('durableLogSource');
    const records = await props?.logSource.getInitialRecords();
    expect(records?.map((record) => record.message)).toEqual(['web buffer record']);
    const unsubscribe = props?.logSource.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe?.();
  });
});
