import { CopyTextButton } from '@brainstrike/ui';
import type { CredentialSlot } from './credential-slots';

/**
 * LEGAL COPY — do not reword without reopening the OAuth legal gate.
 *
 * Binding constraint 4 of `docs/OAUTH_LEGAL_REVIEW_GATE.md` requires the
 * connect UI to state that subscription auth uses the user's OWN ChatGPT
 * subscription for personal use, and that commercial or multi-user serving
 * requires platform API keys. It is a constant — not registry metadata — so
 * that a registry edit can never silently remove a required disclosure.
 *
 * `openai-codex` is today's only `oauth_subscription` provider and the gate is
 * OpenAI-specific; a second subscription provider must bring its own gate
 * ruling and turn this into a per-provider lookup rather than widen the
 * wording.
 */
export const OAUTH_PERSONAL_USE_NOTICE =
  'Uses your own ChatGPT subscription for personal use. Commercial or multi-user serving requires platform API keys.';

/**
 * The always-visible help text under a subscription row. It renders BEFORE any
 * connect action is taken (and stays afterwards), so the personal-use terms
 * are never something the user only meets after signing in.
 */
export function CredentialOAuthNotice({ slot }: { readonly slot: CredentialSlot }) {
  return (
    <div className="space-y-1 py-1">
      <p
        className="text-muted-foreground text-xs"
        data-testid={`credential-oauth-personal-use-${slot.id}`}
      >
        {OAUTH_PERSONAL_USE_NOTICE}
      </p>
      {slot.docsUrl ? (
        // Same treatment as the key editor's docs line: settings-ui has no
        // openExternal capability injection yet, so the URL renders as
        // selectable text with a copy button rather than a dead anchor.
        <div className="flex items-center gap-1">
          <p
            className="select-all break-all text-muted-foreground text-xs"
            data-testid={`credential-oauth-docs-${slot.id}`}
          >
            How sign-in works: {slot.docsUrl}
          </p>
          <CopyTextButton
            ariaLabel={`Copy the ${slot.displayName} sign-in documentation URL`}
            text={slot.docsUrl}
          />
        </div>
      ) : null}
    </div>
  );
}
