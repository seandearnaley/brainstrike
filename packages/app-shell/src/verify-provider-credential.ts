import type { ProviderVerificationSnapshot } from '@brainstrike/assistant-contract';
import { fetchProviderVerification } from './provider-verification-client';

/**
 * Run one verification probe, resolving the assistant transport first.
 *
 * A plain async FUNCTION, deliberately: settings-ui owns the Provider Hub's
 * probe UI but cannot import this package (app-shell depends on settings-ui,
 * so the reverse would close a cycle). Handing it a hook would break the rules
 * of hooks at the wiring site — a hook may not be passed as a value — whereas
 * a function is just data. The React state around it lives in the component
 * that renders it (`use-provider-verification-state` in settings-ui).
 *
 * BST-1378: this module is deliberately NOT named `use-*`. It used to share a
 * file with a `useProviderVerification` hook (the pre-BST-1358 shape); that
 * hook lost its last consumer when settings-ui took ownership of the
 * lifecycle, and a `use-*.ts` file exporting only a non-hook is exactly the
 * confusion that produced the rules-of-hooks violation in the first place.
 */
export function verifyProviderCredential(
  providerId: string,
  signal: AbortSignal
): Promise<ProviderVerificationSnapshot> {
  return fetchProviderVerification({ authHeaders: {}, baseUrl: '/api', providerId, signal });
}
