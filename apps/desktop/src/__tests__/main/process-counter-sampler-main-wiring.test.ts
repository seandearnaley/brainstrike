import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMainSourceSections } from './main-source-test-helpers';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

/** The `createProcessCounterSampler({ … })` argument, whatever order its keys take. */
function wiringBlock(): string {
  const start = source.indexOf('createProcessCounterSampler({');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('});', start));
}

describe('process counter sampler main wiring', () => {
  it('reads through db-main getDatabase, not a raw DB host call', () => {
    expect(wiringBlock()).toContain('getDatabase,');
    expect(wiringBlock()).not.toContain('getDbHostManager()');
  });

  it('submits the read as scheduled work, which waits out the factory-reset barrier', () => {
    expect(wiringBlock()).toContain('runScheduledWork: runDesktopScheduledDatabaseWork,');
  });

  it('stops the sampler in the shutdown database step before the scheduler idle join', () => {
    // Bounded to the database step's own body: an unbounded slice runs to end
    // of file, where a LATER step's idle join could stand in for this one's.
    const step = readMainSourceSections().stepBody('database');

    const stopAt = step.indexOf('processCounterSampler.stop();');
    const idleJoinAt = step.indexOf('await waitForDesktopDatabaseWorkSchedulerIdle();');
    expect(stopAt).toBeGreaterThan(-1);
    expect(idleJoinAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(idleJoinAt);
  });
});
