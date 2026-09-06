import { getWindowRoleByWebContentsId } from '../window-role';

/**
 * Origin tracking for the assistant server's bearer token (BST-1356;
 * PR #2527 review, finding 5).
 *
 * The assistant server is loopback HTTP with ONE process-wide token, so a
 * turn carries no window identity of its own. The token is only obtainable
 * through the `assistant:get-auth` IPC channel, which is already
 * `{ roles: ['visible-ui'] }`. Recording WHO obtained it turns that role
 * check into something the credential-resolution layer can consult per
 * request, instead of the weaker process-wide "is any visible-ui window
 * open?" probe.
 *
 * Why this is stronger: a future hidden host or background mode that acquires
 * the assistant token by some other path records a non-`visible-ui` role (or
 * none at all), and subscription credential resolution fails closed — even
 * while a normal window happens to be open. That is constraint 4's explicit
 * "now or added later" case.
 */

const issuingWebContentsIds = new Set<number>();

/** Record that `webContentsId` was issued the assistant bearer token. */
export function recordAssistantAuthIssuance(webContentsId: number): void {
  issuingWebContentsIds.add(webContentsId);
}

export function forgetAssistantAuthIssuance(webContentsId: number): void {
  issuingWebContentsIds.delete(webContentsId);
}

/**
 * The role to hand `assertInteractiveProviderAuthSender`.
 *
 * Returns `'visible-ui'` only when a LIVE recorded holder still carries that
 * role. Roles are re-read from the registry on every call (never cached at
 * issuance) so a webContents that was torn down, or whose role entry was
 * cleared, stops authorizing subscription auth immediately.
 *
 * Returns `undefined` when nothing qualifies — which fails closed.
 */
export function resolveAssistantAuthOriginRole(): 'visible-ui' | undefined {
  for (const webContentsId of issuingWebContentsIds) {
    if (getWindowRoleByWebContentsId(webContentsId) === 'visible-ui') {
      return 'visible-ui';
    }
  }
  return;
}

/** Test-only teardown. */
export function resetAssistantAuthOriginsForTest(): void {
  issuingWebContentsIds.clear();
}
