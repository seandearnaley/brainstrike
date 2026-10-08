import { expect, test } from 'vitest';
// Evaluating the support module installs its timed MessageChannel.
import { measurePublication } from './committed-assistant-browser-support';

/**
 * BST-1929 positive control for the support's coverage accounting: a
 * MessageChannel task that is neither React's Scheduler nor assistant-ui tap
 * ("other") counts as timed work for commit coverage, so it must also be
 * charged to `reactMs`.
 */
test('an "other" MessageChannel task the publication causes is charged to reactMs', async () => {
  const busyMs = 20;
  const timing = await measurePublication(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = function injectedOtherTask() {
      const start = performance.now();
      while (performance.now() - start < busyMs) {
        // The injected work itself.
      }
      channel.port1.close();
    };
    channel.port2.postMessage(0);
  }, false);
  expect(timing.deferredOtherMs).toBeGreaterThanOrEqual(busyMs);
  expect(timing.reactMs).toBeGreaterThanOrEqual(timing.publishSyncMs + timing.deferredOtherMs);
});
