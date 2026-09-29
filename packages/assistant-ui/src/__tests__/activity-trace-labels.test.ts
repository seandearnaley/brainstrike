import { describe, expect, it } from 'vitest';
import {
  announcementFor,
  headlineFor,
  isWaitingForUser,
  metaFor,
  verbMetaFor,
} from '../activity-trace-labels';
import type { ActivitySummary } from '../activity-trace-model';

/**
 * Seam test for `activity-trace-labels.ts` (BST-1684 review follow-through,
 * Minor 5): the trace group's pure label derivations, exercised directly with
 * no component tree. Mirrors the behaviour already pinned by
 * `activity-trace.test.tsx` — no new wording invented here.
 */
const summaryWith = (waiting: boolean): ActivitySummary => ({
  counts: { failed: 0, steps: 1 },
  live: '',
  resting: 'Worked',
  verbs: null,
  waiting,
});

describe('headlineFor', () => {
  it('running: falls through to the resting headline', () => {
    expect(headlineFor('running', 'Read 2 files')).toBe('Read 2 files');
  });

  it('done: falls through to the resting headline', () => {
    expect(headlineFor('done', 'Worked')).toBe('Worked');
  });

  it('failed: overrides with the fixed "Activity failed" text', () => {
    expect(headlineFor('failed', 'Read 2 files')).toBe('Activity failed');
  });

  it('cancelled: overrides with the fixed "Stopped" text', () => {
    expect(headlineFor('cancelled', 'Read 2 files')).toBe('Stopped');
  });
});

describe('metaFor', () => {
  it('running: reads "· Worked for <elapsed>"', () => {
    expect(metaFor('running', '3.0s')).toBe('· Worked for 3.0s');
  });

  it('done: reads "· Worked for <elapsed>"', () => {
    expect(metaFor('done', '5.0s')).toBe('· Worked for 5.0s');
  });

  it('failed: omitted entirely, regardless of the elapsed label', () => {
    expect(metaFor('failed', '2.0s')).toBeNull();
  });

  it('cancelled: continues its own headline as "Stopped after <elapsed>"', () => {
    expect(metaFor('cancelled', '4.0s')).toBe(' after 4.0s');
  });
});

describe('verbMetaFor', () => {
  it('running: demotes the verb summary to a meta segment', () => {
    expect(verbMetaFor('running', 'Read 2 files', 1)).toBe('Read 2 files');
  });

  it('done: stays null — the verb summary already IS the headline', () => {
    expect(verbMetaFor('done', 'Read 2 files', 1)).toBeNull();
  });

  it('failed: demotes the verb summary to a meta segment', () => {
    expect(verbMetaFor('failed', 'Read 2 files', 1)).toBe('Read 2 files');
  });

  it('cancelled: demotes the verb summary to a meta segment', () => {
    expect(verbMetaFor('cancelled', 'Read 2 files', 1)).toBe('Read 2 files');
  });
});

describe('isWaitingForUser', () => {
  it('running: true when the summary reports a pending gate', () => {
    expect(isWaitingForUser('running', summaryWith(true))).toBe(true);
  });

  it('done: false even if the summary still reports waiting', () => {
    expect(isWaitingForUser('done', summaryWith(true))).toBe(false);
  });

  it('failed: false even if the summary still reports waiting', () => {
    expect(isWaitingForUser('failed', summaryWith(true))).toBe(false);
  });

  it('cancelled: false even if the summary still reports waiting', () => {
    expect(isWaitingForUser('cancelled', summaryWith(true))).toBe(false);
  });
});

describe('announcementFor', () => {
  it('running: reads "Working" while not paused on the user', () => {
    expect(announcementFor('running', summaryWith(false))).toBe('Working');
  });

  it('done: reads "Finished"', () => {
    expect(announcementFor('done', summaryWith(false))).toBe('Finished');
  });

  it('failed: reads "Failed"', () => {
    expect(announcementFor('failed', summaryWith(false))).toBe('Failed');
  });

  it('cancelled: reads "Stopped"', () => {
    expect(announcementFor('cancelled', summaryWith(false))).toBe('Stopped');
  });

  it('running + waiting: the one exception, reads "Waiting for approval" instead of the phase text', () => {
    expect(announcementFor('running', summaryWith(true))).toBe('Waiting for approval');
  });
});
