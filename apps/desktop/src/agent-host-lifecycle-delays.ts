import {
  formatLifecycleDelays,
  LIFECYCLE_DELAYS_ENV,
  lifecycleDelay,
  takeLifecycleDelays,
} from '@brainstrike/host-lease/lifecycle-delays';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';

/**
 * The E2E slow-machine delays Main handed this agent host, taken from its env at the host's
 * first import, so no descendant inherits them. Empty outside a test-mode launch.
 */
export const agentHostLifecycleDelays = takeLifecycleDelays();

/** The host's own points, and the ones it forwards to the index utilities Main forks for it. */
export const agentHostLifecycleDelaySeam: LifecycleDelaySeam = {
  childEnv: (points) => {
    const forwarded = formatLifecycleDelays(agentHostLifecycleDelays, points);
    return forwarded === '' ? {} : { [LIFECYCLE_DELAYS_ENV]: forwarded };
  },
  delay: (point) => lifecycleDelay(agentHostLifecycleDelays, point),
};
