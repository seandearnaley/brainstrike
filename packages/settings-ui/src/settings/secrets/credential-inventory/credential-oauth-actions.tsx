import type { ProviderAuthStatus } from '@brainstrike/assistant-contract/provider-auth';
import { Button, CopyTextButton } from '@brainstrike/ui';
import { useState } from 'react';
import { openExternalLink } from '../../external-link';
import type { CredentialSlot } from './credential-slots';
import { getProviderAuthCapability, type ProviderAuthBridge } from './provider-auth-capability';
import { type ProviderAuthController, useProviderAuthStatus } from './use-provider-auth-status';

interface ActionsProps {
  readonly controller: ProviderAuthController;
  readonly slot: CredentialSlot;
}

function CancelAction({ controller, slot }: ActionsProps) {
  return (
    <Button
      data-testid={`credential-oauth-cancel-${slot.id}`}
      disabled={controller.busy}
      onClick={controller.cancel}
      size="sm"
      variant="secondary"
    >
      Cancel
    </Button>
  );
}

function ConnectActions({ controller, slot }: ActionsProps) {
  return (
    <>
      <Button
        data-testid={`credential-oauth-connect-${slot.id}`}
        disabled={controller.busy}
        onClick={controller.connect}
        size="sm"
      >
        Connect
      </Button>
      <Button
        data-testid={`credential-oauth-device-${slot.id}`}
        disabled={controller.busy}
        onClick={controller.connectWithDeviceCode}
        size="sm"
        variant="secondary"
      >
        Use a device code
      </Button>
    </>
  );
}

function DeviceCodeActions({
  controller,
  slot,
  status,
}: ActionsProps & { readonly status: ProviderAuthStatus & { state: 'awaiting_device_code' } }) {
  const [linkError, setLinkError] = useState<string | null>(null);
  return (
    <>
      <code
        className="rounded bg-muted px-2 py-1 font-mono font-semibold text-sm tracking-widest"
        data-testid={`credential-oauth-user-code-${slot.id}`}
      >
        {status.userCode}
      </code>
      <span data-testid={`credential-oauth-copy-code-${slot.id}`}>
        <CopyTextButton
          ariaLabel={`Copy the ${slot.displayName} device code`}
          label="Copy code"
          text={status.userCode}
        />
      </span>
      {/* The device flow hands the verification URI to the renderer, so this link must actually work. */}
      <a
        className="break-all text-primary text-xs underline"
        data-testid={`credential-oauth-verification-uri-${slot.id}`}
        href={status.verificationUri}
        onClick={(event) =>
          void openExternalLink(event, status.verificationUri).then((failure) =>
            setLinkError(failure === undefined ? null : `Couldn't open link: ${failure}`)
          )
        }
        rel="noreferrer"
        target="_blank"
      >
        {status.verificationUri}
      </a>
      {linkError ? (
        <span
          className="text-destructive text-xs"
          data-testid={`credential-oauth-link-error-${slot.id}`}
          role="alert"
        >
          {linkError}
        </span>
      ) : null}
      <CancelAction controller={controller} slot={slot} />
    </>
  );
}

function StatusActions({ controller, slot }: ActionsProps) {
  const { status } = controller;
  if (!status) {
    return (
      <span
        className="text-muted-foreground text-xs"
        data-testid={`credential-oauth-checking-${slot.id}`}
      >
        Checking sign-in…
      </span>
    );
  }
  switch (status.state) {
    case 'awaiting_device_code':
      return <DeviceCodeActions controller={controller} slot={slot} status={status} />;
    case 'awaiting_browser':
    case 'connecting':
      return (
        <>
          <span
            className="text-muted-foreground text-xs"
            data-testid={`credential-oauth-waiting-${slot.id}`}
          >
            Waiting for browser…
          </span>
          <CancelAction controller={controller} slot={slot} />
        </>
      );
    case 'connected':
      return (
        <>
          <span className="text-xs" data-testid={`credential-oauth-account-${slot.id}`}>
            {status.accountId ?? 'Connected'}
          </span>
          <Button
            data-testid={`credential-oauth-disconnect-${slot.id}`}
            disabled={controller.busy}
            onClick={controller.disconnect}
            size="sm"
            variant="secondary"
          >
            Disconnect
          </Button>
        </>
      );
    case 'reconnect_required':
      return (
        <>
          <span
            className="text-warning text-xs"
            data-testid={`credential-oauth-session-expired-${slot.id}`}
          >
            Session expired — sign in again.
          </span>
          <Button
            data-testid={`credential-oauth-reconnect-${slot.id}`}
            disabled={controller.busy}
            onClick={controller.connect}
            size="sm"
          >
            Reconnect
          </Button>
        </>
      );
    case 'error':
      return (
        <>
          <span
            className="text-destructive text-xs"
            data-testid={`credential-oauth-error-${slot.id}`}
          >
            Sign-in failed ({status.code}).
          </span>
          <ConnectActions controller={controller} slot={slot} />
        </>
      );
    case 'disconnected':
      return <ConnectActions controller={controller} slot={slot} />;
    default:
      // A state this build does not know is NOT treated as disconnected —
      // offering Connect there would guess at the flow's real position.
      return (
        <span
          className="text-muted-foreground text-xs"
          data-testid={`credential-oauth-unknown-${slot.id}`}
        >
          Sign-in state unrecognized.
        </span>
      );
  }
}

function ProviderAuthActions({
  bridge,
  slot,
}: {
  readonly bridge: ProviderAuthBridge;
  readonly slot: CredentialSlot;
}) {
  const controller = useProviderAuthStatus(bridge, slot.id);
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {controller.error ? (
        <span
          className="text-destructive text-xs"
          data-testid={`credential-oauth-bridge-error-${slot.id}`}
        >
          {controller.error}
        </span>
      ) : null}
      <StatusActions controller={controller} slot={slot} />
    </span>
  );
}

/**
 * Actions cell for an `oauth_subscription` slot (BST-1356): sign-in, not a
 * secret field. Capability-gated on `window.providerAuth` — without the
 * desktop bridge the row states that plainly and offers NO connect affordance,
 * rather than rendering buttons that could not work.
 */
export function CredentialOAuthActions({ slot }: { readonly slot: CredentialSlot }) {
  const bridge = getProviderAuthCapability();
  if (!bridge) {
    return (
      <span
        className="text-muted-foreground text-xs"
        data-testid={`credential-oauth-unavailable-${slot.id}`}
      >
        Subscription sign-in is available in the desktop app.
      </span>
    );
  }
  return <ProviderAuthActions bridge={bridge} slot={slot} />;
}
