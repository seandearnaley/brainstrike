import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

describe('process counter sampler main wiring', () => {
  it('reads through the scheduled, reset-barrier-gated database seam', () => {
    // `getDatabase` shorthand is db-main's; `runDesktopScheduledDatabaseWork`
    // waits out the factory-reset barrier before admitting the read.
    expect(source).toMatch(
      /createProcessCounterSampler\(\{[^}]*\bgetDatabase,[^}]*\brunScheduledWork: runDesktopScheduledDatabaseWork,[^}]*\}\)/
    );
  });

  it('stops the sampler in the shutdown database step before the scheduler idle join', () => {
    const step = source.slice(source.indexOf("runShutdownStep('database'"));
    const stopAt = step.indexOf('processCounterSampler.stop();');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(step.indexOf('await waitForDesktopDatabaseWorkSchedulerIdle();'));
  });
});
