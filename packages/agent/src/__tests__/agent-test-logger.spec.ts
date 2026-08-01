import { __loggerTesting, addLogListener, info, type LogRecord } from '@brainstrike/utils/logger';
import { expect, it } from 'vitest';

it('keeps agent unit logs observable without writing them to the console transport', () => {
  expect(__loggerTesting.isRootTransportEnabled()).toBe(false);

  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));

  try {
    info('agent unit listener probe');
  } finally {
    unsubscribe();
  }

  expect(records.map((record) => record.message)).toEqual(['agent unit listener probe']);
});
