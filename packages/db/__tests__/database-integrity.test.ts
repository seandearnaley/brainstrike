import type { DatabaseIntegrityState } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { isBackgroundDatabaseWorkAdmitted } from '../src/database-integrity';

describe('isBackgroundDatabaseWorkAdmitted', () => {
  it('admits background database work while the database is healthy', () => {
    expect(isBackgroundDatabaseWorkAdmitted({ kind: 'healthy' })).toBe(true);
  });

  it('pauses background database work while an integrity error is contained', () => {
    const contained: DatabaseIntegrityState = {
      context: 'db:query',
      kind: 'contained',
      signal: { message: 'index "idx" contains unexpected zero page', sqlstate: 'XX002' },
      since: '2026-09-29T12:00:00.000Z',
    };
    expect(isBackgroundDatabaseWorkAdmitted(contained)).toBe(false);
  });
});
