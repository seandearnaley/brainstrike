/**
 * The code-execution policy grammar shared by the `run_python` input schema
 * (browser-safe, this package) and the Node-only execution seam
 * (`@brainstrike/agent/code-execution`, which re-exports these names).
 *
 * Extracted from the seam in BST-1646 so the native-tool input schemas can live
 * on the browser-safe side of the Mastra boundary without pulling the seam in.
 * The seam remains the single owner of every OTHER policy decision.
 */
import { z } from 'zod';

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
 */
export const policyDomainSchema = z
  .string()
  .min(1)
  .max(MAX_POLICY_DOMAIN_LENGTH)
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' })
  .refine((value) => value !== '*', {
    message: 'a bare "*" wildcard is not expressible; list explicit domains',
  })
  .refine((value) => !value.startsWith('*.') || value.slice(2).includes('.'), {
    message:
      'a wildcard must name a parent domain of at least two labels (e.g. "*.example.com", not "*.com")',
  })
  .refine((value) => DOMAIN_PATTERN.test(value), {
    message: 'must be a hostname or a "*.example.com" wildcard',
  });
