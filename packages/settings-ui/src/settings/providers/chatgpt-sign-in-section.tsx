import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  CHATGPT_USAGE_URL,
  type ChatGptSignInStatus,
  resolveChatGptSignInBridge,
} from '@brainstrike/assistant-contract/chatgpt-sign-in';
import { Button, ErrorNotice, ProviderIcon } from '@brainstrike/ui';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * What the section last learned from the host. `notice` is the one line that
 * follows an action: plan use confirmed after a first sign-in, or a sign-out
 * OpenAI did not confirm.
 */
interface SectionState {
  readonly error: string | undefined;
  readonly notice: 'plan-in-use' | 'sign-out-unconfirmed' | undefined;
  /** `undefined` until the host has answered once. */
  readonly status: ChatGptSignInStatus | undefined;
}

function ManageUsageLink({ providerId }: { readonly providerId: string }) {
  return (
    <Button asChild className="h-auto p-0 text-xs" variant="link">
      <a
        data-testid={`provider-manage-usage-${providerId}`}
        href={CHATGPT_USAGE_URL}
        rel="noreferrer"
        target="_blank"
      >
        Manage usage
        <ExternalLink aria-hidden="true" className="ml-1 size-3" />
      </a>
    </Button>
  );
}

/**
 * Sign in with ChatGPT on its provider card (ADR-0038), laid out as OpenAI's
 * UI guidelines ask: a Continue with ChatGPT action, the signed-in account
 * with a Manage usage link, and one confirmation that the plan is in use.
 * https://developers.openai.com/siwc/ui-ux-guidelines
 *
 * The host owns the sign-in and its tokens; this reads a state and an email.
 *
 * @platform desktop
 */
export function ChatGptSignInSection({ providerId }: { readonly providerId: string }) {
  // The preload bridge cannot appear mid-session, so it is resolved once.
  const [bridge] = useState(resolveChatGptSignInBridge);
  const notifySecretsChanged = useSecretsStore((state) => state.notifySecretsChanged);
  const [state, setState] = useState<SectionState>({
    error: undefined,
    notice: undefined,
    status: undefined,
  });

  // biome-ignore lint/plugin: Not derived state: a one-shot async read of the host's sign-in status over the preload bridge, which cannot be computed during render; `current` discards an answer that lands after unmount.
  useEffect(() => {
    if (!bridge) {
      return;
    }
    let current = true;
    const show = (status: ChatGptSignInStatus) => {
      if (current) {
        setState((previous) => ({ ...previous, status }));
      }
    };
    const failed = (cause: unknown) => {
      if (current) {
        setState((previous) => ({ ...previous, error: describeBoundaryError(cause) }));
      }
    };
    bridge.status(false).then((status) => {
      show(status);
      // A sign-in started before this section opened: show how it ended.
      if (status.state === 'signing_in') {
        bridge.status(true).then((settled) => {
          show(settled);
          notifySecretsChanged();
        }, failed);
      }
    }, failed);
    return () => {
      current = false;
    };
  }, [bridge, notifySecretsChanged]);

  if (!bridge) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid={`provider-readonly-note-${providerId}`}
      >
        Sign in with ChatGPT from the Brainstrike desktop app.
      </p>
    );
  }

  const signIn = async (newAccount: boolean) => {
    const before = state.status;
    setState({ error: undefined, notice: undefined, status: { state: 'signing_in' } });
    try {
      const status = await bridge.signIn(newAccount);
      setState({
        error: undefined,
        notice: status.state === 'signed_in' && status.firstSignIn ? 'plan-in-use' : undefined,
        status,
      });
    } catch (cause) {
      // A refused sign-in changed nothing the host had not already recorded.
      const status = await bridge.status(false).catch(() => before);
      setState({ error: describeBoundaryError(cause), notice: undefined, status });
    }
    // Signed in or not, the card's connection is re-read from the host.
    notifySecretsChanged();
  };

  const signOut = async () => {
    try {
      const { revoked } = await bridge.signOut();
      setState({
        error: undefined,
        notice: revoked ? undefined : 'sign-out-unconfirmed',
        status: await bridge.status(false),
      });
    } catch (cause) {
      setState((previous) => ({ ...previous, error: describeBoundaryError(cause) }));
    }
    notifySecretsChanged();
  };

  const cancel = () => {
    // The pending sign-in answers "cancelled", which is what settles this section.
    bridge.cancel().catch((cause: unknown) => {
      setState((previous) => ({ ...previous, error: describeBoundaryError(cause) }));
    });
  };

  const { error, notice, status } = state;
  return (
    <div className="space-y-3 text-xs" data-testid={`provider-sign-in-${providerId}`}>
      {status?.state === 'signed_in' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p
              className="text-sm font-medium"
              data-testid={`provider-sign-in-account-${providerId}`}
            >
              {status.email ? `Signed in as ${status.email}` : 'Signed in'}
            </p>
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2">
              Using your ChatGPT plan
              <ManageUsageLink providerId={providerId} />
            </p>
          </div>
          <Button
            data-testid={`provider-sign-out-${providerId}`}
            onClick={() => void signOut()}
            size="sm"
            variant="outline"
          >
            Sign out
          </Button>
        </div>
      ) : null}

      {status?.state === 'signed_out' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Use your ChatGPT plan</p>
            <p className="text-muted-foreground">
              Complete eligible AI requests in Brainstrike with usage included in your ChatGPT plan
              or credits balance. No API key is needed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="bg-foreground text-background hover:bg-foreground/90"
              data-testid={`provider-sign-in-continue-${providerId}`}
              onClick={() => void signIn(false)}
              size="sm"
            >
              <ProviderIcon providerId={providerId} />
              Continue with ChatGPT
            </Button>
            {status.email ? (
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-2">
                Continues as {status.email}.
                <Button
                  className="h-auto p-0 text-xs"
                  data-testid={`provider-sign-in-new-account-${providerId}`}
                  onClick={() => void signIn(true)}
                  variant="link"
                >
                  Use a different account
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {status?.state === 'signing_in' ? (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          <span>Finish signing in to ChatGPT in your browser.</span>
          <Button
            data-testid={`provider-sign-in-cancel-${providerId}`}
            onClick={cancel}
            size="xs"
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {notice === 'plan-in-use' ? (
        <div
          className="border-success/30 bg-success/5 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
          data-testid={`provider-plan-in-use-${providerId}`}
          role="status"
        >
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{"You're using your ChatGPT plan"}</p>
            <p className="text-muted-foreground">
              Eligible requests to ChatGPT models in Brainstrike use your ChatGPT plan. You can
              review and limit that usage in ChatGPT settings.
            </p>
          </div>
          <Button
            onClick={() => setState((previous) => ({ ...previous, notice: undefined }))}
            size="sm"
            variant="outline"
          >
            Got it
          </Button>
        </div>
      ) : null}

      {notice === 'sign-out-unconfirmed' ? (
        <p className="text-warning" role="status">
          Signed out here, but OpenAI did not confirm ending the session. You can disconnect
          Brainstrike in ChatGPT settings. <ManageUsageLink providerId={providerId} />
        </p>
      ) : null}

      {error ? (
        <ErrorNotice data-testid={`provider-sign-in-error-${providerId}`} message={error} />
      ) : null}
    </div>
  );
}
