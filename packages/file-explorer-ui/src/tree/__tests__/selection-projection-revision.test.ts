import { describe, expect, it } from 'vitest';
import { createSelectionProjectionRevisionTracker } from '../selection-projection-revision';

describe('createSelectionProjectionRevisionTracker', () => {
  it('advances monotonically for path or root changes', () => {
    const tracker = createSelectionProjectionRevisionTracker();

    expect(tracker.read('root-a', ['/a.ts'])).toBe(0);
    expect(tracker.read('root-a', ['/b.ts'])).toBe(1);
    expect(tracker.read('root-b', ['/b.ts'])).toBe(2);
  });

  it('does not advance for value-equivalent projection replacements', () => {
    const tracker = createSelectionProjectionRevisionTracker();

    expect(tracker.read('root-a', ['/a.ts', '/b.ts'])).toBe(0);
    expect(tracker.read('root-a', new Set(['/b.ts', '/a.ts']))).toBe(0);
  });
});
