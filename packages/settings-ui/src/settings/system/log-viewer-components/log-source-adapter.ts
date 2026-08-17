import type { LogRecord } from '@brainstrike/logging';

export interface LogSourceAdapter {
  getInitialRecords?: () => Promise<readonly LogRecord[]>;
  subscribe?: (handler: (records: readonly LogRecord[]) => void) => () => void;
}
