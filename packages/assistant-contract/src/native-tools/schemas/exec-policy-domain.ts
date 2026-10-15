/**
 * The code-execution policy grammar shared by the `run_python` input schema
 * (browser-safe, this package) and the Node-only execution seam
 * (`@brainstrike/agent/code-execution`, which re-exports these names).
 *
 * Extracted from the seam in BST-1646 so the native-tool input schemas can live
 * on the browser-safe side of the Mastra boundary without pulling the seam in.
 * The seam remains the single owner of every OTHER policy decision.
 *
 * Authored in Effect Schema: ADR-0004 (amended 2026-10-15) makes Effect the
 * single boundary owner. This leaf is NOT a registered tool input schema, so
 * `effectToolInputSchema` does not apply to it — it is composed by
 * `schemas-execution.ts` (`run_python`'s domain grammar) and by the seam's
 * `execPolicySchema`. Both had to convert in the same change: a zod twin of
 * this grammar would be a second writer for the safety-critical invariant
 * below.
 */
import { Schema } from 'effect';

export const MAX_POLICY_DOMAIN_LENGTH = 253;
export const MAX_POLICY_ENTRIES = 256;
export const MAX_EXEC_CODE_LENGTH = 1_000_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

const DOMAIN_PATTERN =
  /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * A hostname or a `*.example.com` wildcard. A BARE `*` is rejected: an empty
 * `allowedDomains` list meaning "no network" is this policy's safety-critical
 * invariant, and a single wildcard entry would invert it. Unrestricted egress
 * is deliberately not expressible.
 *
 * The four grammar rules are `Schema.makeFilter`, not `Schema.isPattern`, for
 * two reasons: each keeps its own message, and a filter advertises nothing —
 * which is what the zod `.refine()` chain did. `isPattern` would emit a
 * `pattern` keyword only for a RegExp carrying the Unicode flag anyway, and
 * `DOMAIN_PATTERN` is case-insensitive.
 */
export const policyDomainSchema = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxLength(MAX_POLICY_DOMAIN_LENGTH),
  Schema.makeFilter((value) => (value.trim().length > 0 ? undefined : 'must not be blank')),
  Schema.makeFilter((value) =>
    value === '*' ? 'a bare "*" wildcard is not expressible; list explicit domains' : undefined
  ),
  Schema.makeFilter((value) =>
    !value.startsWith('*.') || value.slice(2).includes('.')
      ? undefined
      : 'a wildcard must name a parent domain of at least two labels (e.g. "*.example.com", not "*.com")'
  ),
  Schema.makeFilter((value) =>
    DOMAIN_PATTERN.test(value) ? undefined : 'must be a hostname or a "*.example.com" wildcard'
  )
);
