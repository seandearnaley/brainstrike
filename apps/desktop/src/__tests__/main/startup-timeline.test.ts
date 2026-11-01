import { expect, it } from 'vitest';
import { startupTimeline } from '../../startup-timeline';

it('reports milestones in ms from process start and names the ones that never happened', () => {
  expect(
    startupTimeline([
      { name: 'startup:bootstrap', startTime: 41.6 },
      { name: 'unrelated', startTime: 50 },
      { name: 'startup:windowShown', startTime: 812.2 },
      { name: 'startup:agentHostReady', startTime: 1903.5 },
    ])
  ).toEqual({
    absent: ['shellEnvironment', 'firstContentfulPaint'],
    ms: { agentHostReady: 1904, bootstrap: 42, windowShown: 812 },
  });
});
