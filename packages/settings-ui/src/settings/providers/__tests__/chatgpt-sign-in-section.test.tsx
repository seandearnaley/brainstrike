import '@testing-library/jest-dom/vitest';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChatGptSignInStatus } from '@brainstrike/assistant-contract/chatgpt-sign-in';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptSignInSection } from '../chatgpt-sign-in-section';

type Answer<T> = Promise<BoundaryResult<T>>;
const ok = <T,>(value: T): Answer<T> => Promise.resolve({ ok: true, value });

/**
 * The host behind the preload bridge, as the section may know it: a status and
 * an email. `browser` is what the person does once the sign-in page opens.
 */
function installHost(options: {
  readonly browser?: () => Answer<ChatGptSignInStatus>;
  readonly revokes?: boolean;
  readonly status: ChatGptSignInStatus;
}) {
  const host = { calls: [] as string[], status: options.status };
  Object.defineProperty(window, 'chatGptSignIn', {
    configurable: true,
    value: {
      cancel: () => ok(undefined),
      signIn: async (newAccount: boolean) => {
        host.calls.push(newAccount ? 'sign-in:new-account' : 'sign-in');
        const answer = await (options.browser?.() ?? ok({ state: 'signed_out' as const }));
        if (answer.ok) {
          host.status = answer.value;
        }
        return answer;
      },
      signOut: () => {
        host.calls.push('sign-out');
        host.status = { email: 'ada@example.com', state: 'signed_out' };
        return ok({ revoked: options.revokes ?? true });
      },
      status: () => ok(host.status),
    },
  });
  return host;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'chatGptSignIn');
});

describe('ChatGptSignInSection', () => {
  it('offers Continue with ChatGPT, then confirms once that the plan is in use', async () => {
    const user = userEvent.setup();
    const host = installHost({
      browser: () => ok({ email: 'ada@example.com', firstSignIn: true, state: 'signed_in' }),
      status: { state: 'signed_out' },
    });
    const listingsBefore = useSecretsStore.getState().secretsVersion;
    render(<ChatGptSignInSection providerId="chatgpt" />);

    await user.click(await screen.findByRole('button', { name: 'Continue with ChatGPT' }));

    expect(await screen.findByText('Signed in as ada@example.com')).toBeVisible();
    expect(screen.getByText("You're using your ChatGPT plan")).toBeVisible();
    for (const link of screen.getAllByRole('link', { name: /Manage usage/u })) {
      expect(link).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
    }
    expect(host.calls).toEqual(['sign-in']);
    // The provider card re-reads its connection once the sign-in settles.
    expect(useSecretsStore.getState().secretsVersion).toBeGreaterThan(listingsBefore);

    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText("You're using your ChatGPT plan")).not.toBeInTheDocument();
    expect(screen.getByText('Using your ChatGPT plan')).toBeVisible();
  });

  it('shows why a sign-in was refused and leaves the account signed out', async () => {
    const user = userEvent.setup();
    installHost({
      browser: () =>
        Promise.resolve({
          error: refusal({
            category: 'authorization',
            code: 'auth.chatgpt-plan-not-granted',
            message: 'ChatGPT signed in without permission to use your plan here.',
            remedy: 'Sign in again and allow plan usage, or add an OpenAI API key instead.',
          }),
          ok: false,
        }),
      status: { state: 'signed_out' },
    });
    render(<ChatGptSignInSection providerId="chatgpt" />);

    await user.click(await screen.findByRole('button', { name: 'Continue with ChatGPT' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ChatGPT signed in without permission to use your plan here. Sign in again and allow plan usage, or add an OpenAI API key instead.'
    );
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
  });

  it('signs out, keeps the account to continue as, and can register a different one', async () => {
    const user = userEvent.setup();
    const host = installHost({
      revokes: false,
      status: { email: 'ada@example.com', state: 'signed_in' },
    });
    render(<ChatGptSignInSection providerId="chatgpt" />);

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    // OpenAI did not confirm: the person is told where to disconnect the app themselves.
    expect(await screen.findByText(/OpenAI did not confirm ending the session/u)).toBeVisible();
    expect(screen.getByText(/Continues as ada@example.com/u)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Use a different account' }));
    await waitFor(() => expect(host.calls).toEqual(['sign-out', 'sign-in:new-account']));
  });

  it('says where to sign in when this window has no host to sign in through', () => {
    render(<ChatGptSignInSection providerId="chatgpt" />);
    expect(
      screen.getByText('Sign in with ChatGPT from the Brainstrike desktop app.')
    ).toBeVisible();
  });
});
