import type { ProviderVerificationStatus } from '@brainstrike/assistant-contract';

/**
 * Visual weight of a probe result. `warning` is the honest home for two
 * DIFFERENT non-failures — a credential that authenticated but could not
 * complete the probe, and a probe that never got an auth verdict at all — so
 * neither is dressed up as success nor condemned as a bad key.
 */
export type ProviderVerificationTone = 'danger' | 'neutral' | 'success' | 'warning';

export interface ProviderVerificationPresentation {
  /** One sentence explaining what the status means for the user's next move. */
  readonly description: string;
  readonly label: string;
  readonly tone: ProviderVerificationTone;
}

/**
 * The BST-1357 wire statuses, rendered. The `Record` is exhaustive by type, so
 * a new contract status is a compile error here rather than an unlabelled
 * badge at runtime.
 */
export const PROVIDER_VERIFICATION_PRESENTATION: Record<
  ProviderVerificationStatus,
  ProviderVerificationPresentation
> = {
  invalid: {
    description: 'The provider rejected this credential. Replace the key and test again.',
    label: 'Invalid key',
    tone: 'danger',
  },
  // biome-ignore lint/style/useNamingConvention: BST-1357 wire status name, matched verbatim to the contract union.
  not_applicable: {
    description: 'There is no key to test for this provider.',
    label: 'Nothing to test',
    tone: 'neutral',
  },
  unreachable: {
    description:
      'No answer from the provider, so the key was never judged. Check your network and try again.',
    label: 'Unreachable',
    tone: 'warning',
  },
  verified: {
    description: 'The credential authenticated successfully.',
    label: 'Verified',
    tone: 'success',
  },
  // biome-ignore lint/style/useNamingConvention: BST-1357 wire status name, matched verbatim to the contract union.
  verified_limited: {
    description:
      'The credential authenticated, but the probe could not fully complete on it — usually a permission-scoped key or a rate limit. The key itself works.',
    label: 'Verified with limits',
    tone: 'warning',
  },
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Human "when was this checked". An unparseable timestamp is reported as
 * unknown rather than rendered as `NaN ago` — the probe's own contract
 * validates `checkedAt`, so this guard only ever fires on a broken producer,
 * and it must not print nonsense when it does.
 */
export function formatCheckedAt(checkedAt: string, now: Date = new Date()): string {
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(checked)) {
    return 'unknown time';
  }
  const elapsed = now.getTime() - checked;
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    return plural(Math.floor(elapsed / MINUTE_MS), 'minute');
  }
  if (elapsed < DAY_MS) {
    return plural(Math.floor(elapsed / HOUR_MS), 'hour');
  }
  return new Date(checked).toLocaleDateString();
}
