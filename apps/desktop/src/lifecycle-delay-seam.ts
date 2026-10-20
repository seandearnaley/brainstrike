import {
  formatLifecycleDelays,
  LIFECYCLE_DELAYS_ENV,
  type LifecycleDelayPoint,
  type LifecycleDelays,
  lifecycleDelay,
  parseLifecycleDelays,
} from '@brainstrike/host-lease/lifecycle-delays';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const logger = createLogger('LifecycleDelaySeam');

/**
 * E2E slow-machine seam (lifecycle redesign §6.1): `BRAINSTRIKE_E2E_LIFECYCLE_DELAYS=point:ms,...`
 * delays each named lifecycle boundary once by `ms`. Read only in an unpackaged test-mode launch;
 * a shipped build never applies it, and no child ever inherits it.
 */
export interface LifecycleDelaySeam {
  /**
   * The environment entry a child needs to apply its own `points`, for that child's spawn env.
   * Empty when the seam is off or none of `points` is set: the child then has no entry at all.
   */
  childEnv(points: readonly LifecycleDelayPoint[]): Readonly<Record<string, string>>;
  /**
   * Main-side point: the first boundary to apply it waits `ms`; every later one, and an unset
   * point, proceeds at once with no timer. Forwarded child points are unaffected (`childEnv`).
   */
  delay(point: LifecycleDelayPoint): Promise<void>;
}

function seamFor(delays: LifecycleDelays): LifecycleDelaySeam {
  return {
    childEnv: (points): Readonly<Record<string, string>> => {
      const forwarded = formatLifecycleDelays(delays, points);
      return forwarded === '' ? {} : { [LIFECYCLE_DELAYS_ENV]: forwarded };
    },
    delay: (point) => lifecycleDelay(delays, point),
  };
}

/**
 * Reads the seam once and removes the variable from `env`, Main's own environment, enabled or not,
 * so every process Main spawns afterwards (utility, renderer, child process) starts without it.
 * A child receives its points only through `childEnv`. Install after the desktop environment
 * files are loaded and before Main spawns anything. A malformed value in an enabled launch throws.
 */
export function createLifecycleDelaySeam(
  env: Record<string, string | undefined> = process.env,
  enabled: () => boolean = () => isElectronE2ETestMode() && !app.isPackaged
): LifecycleDelaySeam {
  const raw = env[LIFECYCLE_DELAYS_ENV];
  delete env[LIFECYCLE_DELAYS_ENV];
  if (raw === undefined || !enabled()) {
    return seamFor(new Map());
  }
  const delays = parseLifecycleDelays(raw);
  logger.warn('E2E lifecycle delays are active', { delays: formatLifecycleDelays(delays) });
  return seamFor(delays);
}

let installed: LifecycleDelaySeam | undefined;

/** Main's one seam, installed once at bootstrap (`main-bootstrap.ts`). */
export function installLifecycleDelaySeam(): LifecycleDelaySeam {
  if (installed) {
    throw new Error('The lifecycle delay seam is already installed');
  }
  installed = createLifecycleDelaySeam();
  return installed;
}

/** The installed seam. Using it before bootstrap installed it is a wiring error. */
export function lifecycleDelaySeam(): LifecycleDelaySeam {
  if (!installed) {
    throw new Error('The lifecycle delay seam is used before main-bootstrap installed it');
  }
  return installed;
}
