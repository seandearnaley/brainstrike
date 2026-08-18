import type {
  DeprecatedEnvVarReport,
  ProviderAuthMode,
  ProviderKeySource,
  StoredKeyFingerprint,
} from '@brainstrike/assistant-contract';
import {
  Badge,
  Button,
  getProviderColor,
  ProviderIcon,
  TableCell,
  TableRow,
  TooltipIconButton,
} from '@brainstrike/ui';
import { Lock } from 'lucide-react';
import type { CSSProperties, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { deprecatedEnvVarMessage } from '../deprecated-env-var-message';
import { KeySourceBadge } from '../key-source-badge';
import type { CredentialSourceState } from '../provider-key-types';
import { CredentialOAuthActions } from './credential-oauth-actions';
import { CredentialOAuthNotice } from './credential-oauth-notice';
import { CredentialRowEditor } from './credential-row-editor';
import type { CredentialSlot } from './credential-slots';

export const CREDENTIAL_TABLE_COLUMN_COUNT = 5;

/** Subscription slots carry a sign-in flow, never a stored secret — so they
 * never open the inline editor and never render Set/Replace/Remove. */
function isOAuthSlot(slot: CredentialSlot): boolean {
  return slot.authType === 'oauth_subscription';
}

interface CredentialRowProps {
  readonly busy: boolean;
  readonly deprecatedReports: readonly DeprecatedEnvVarReport[];
  readonly draftKey: string;
  readonly draftMode: ProviderAuthMode;
  readonly draftProfile: string;
  readonly draftRegion: string;
  readonly editing: boolean;
  /** Cross-link target (BST-1363): scrolls into view and rings while set. */
  readonly highlighted: boolean;
  /**
   * Bumped on every cross-link activation. Clicking the SAME chip twice must
   * re-scroll, and without a changing value the props would be identical and
   * the second click would appear to do nothing.
   */
  readonly highlightNonce: number;
  readonly onCancelEdit: () => void;
  readonly onDraftKeyChange: (value: string) => void;
  readonly onDraftModeChange: (value: ProviderAuthMode) => void;
  readonly onDraftProfileChange: (value: string) => void;
  readonly onDraftRegionChange: (value: string) => void;
  readonly onOpenEditor: () => void;
  readonly onRemove: () => void;
  readonly onSave: () => void;
  readonly slot: CredentialSlot;
  readonly source: ProviderKeySource<string> | undefined;
  readonly sourceState: CredentialSourceState;
}

function fingerprintOf(
  source: ProviderKeySource<string> | undefined
): StoredKeyFingerprint | undefined {
  return source?.source === 'stored' ? source.metadata : undefined;
}

function ProviderNameCell({ slot }: { readonly slot: CredentialSlot }) {
  return (
    <span className="flex items-center gap-2">
      <ProviderIcon
        className="size-4 shrink-0 dark:[color:var(--provider-color-dark)]"
        providerId={slot.id}
        style={
          {
            '--provider-color-dark': getProviderColor(slot.id, 'dark'),
            color: getProviderColor(slot.id, 'light'),
          } as CSSProperties
        }
      />
      {/* `title` so a name the fixed-width column truncates stays readable on
          hover. Measured in the live renderer: "OpenAI (ChatGPT)" needs 118px
          in an 88px cell, so it renders as "OpenAI (Ch…" — ambiguous with the
          plain "OpenAI" row directly above it without this. */}
      <span className="truncate font-medium" title={slot.displayName}>
        {slot.displayName}
      </span>
    </span>
  );
}

/**
 * The Status column. The credential-source listing describes keychain/env
 * secrets, which a subscription slot has none of — so it gets its own label
 * instead of the listing's "Not set", which would read as "no ChatGPT account
 * connected" and be flatly wrong for a signed-in user. The live sign-in state
 * is rendered by the Actions cell, which owns the bridge.
 */
function CredentialStatusCell({
  slot,
  source,
  sourceState,
}: Pick<CredentialRowProps, 'slot' | 'source' | 'sourceState'>) {
  if (isOAuthSlot(slot)) {
    return (
      // `variant="outline"` is load-bearing, not styling preference: Badge's
      // DEFAULT variant paints a solid primary background, so overriding only
      // the text colour left muted grey on solid blue — measured at ~1.16:1
      // contrast in the live renderer, far below WCAG AA. Outline matches the
      // sibling KeySourceBadge treatments (transparent + muted text).
      <Badge
        className="text-muted-foreground"
        data-testid={`credential-status-${slot.id}`}
        variant="outline"
      >
        Subscription sign-in
      </Badge>
    );
  }
  if (sourceState === 'loading') {
    return (
      <span
        className="block h-5 w-24 animate-pulse rounded bg-muted"
        data-testid={`credential-status-skeleton-${slot.id}`}
      />
    );
  }
  return (
    <KeySourceBadge
      source={source}
      sourceState={sourceState}
      testId={`credential-status-${slot.id}`}
    />
  );
}

function RowActions({
  busy,
  editorTriggerRef,
  onOpenEditor,
  onRemove,
  slot,
  source,
  sourceState,
}: Pick<
  CredentialRowProps,
  'busy' | 'onOpenEditor' | 'onRemove' | 'slot' | 'source' | 'sourceState'
> & {
  readonly editorTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  // FIRST, ahead of every keychain/env branch: a subscription slot has no
  // secret to set, replace or remove, and its sign-in state is independent of
  // the credential-source listing — so it must never fall through to those
  // affordances, not even while the listing is still loading (BST-1356).
  if (isOAuthSlot(slot)) {
    return <CredentialOAuthActions slot={slot} />;
  }
  if (sourceState === 'loading') {
    return null;
  }
  const actionsDisabled = busy || sourceState !== 'ready';
  if (source?.source === 'env') {
    return (
      <TooltipIconButton
        data-testid={`credential-env-lock-${slot.id}`}
        tooltip={`${source.envVar} is authoritative; remove it and restart to manage here.`}
      >
        <Lock className="size-3.5" />
      </TooltipIconButton>
    );
  }
  if (source?.source === 'stored') {
    return (
      <span className="flex justify-end gap-2">
        <Button
          data-testid={`credential-replace-${slot.id}`}
          disabled={actionsDisabled}
          onClick={onOpenEditor}
          ref={editorTriggerRef}
          size="sm"
          variant="secondary"
        >
          Replace
        </Button>
        <Button
          data-testid={`credential-remove-${slot.id}`}
          disabled={actionsDisabled}
          onClick={onRemove}
          size="sm"
          variant="secondary"
        >
          Remove
        </Button>
      </span>
    );
  }
  return (
    <Button
      data-testid={`credential-set-${slot.id}`}
      disabled={actionsDisabled}
      onClick={onOpenEditor}
      ref={editorTriggerRef}
      size="sm"
    >
      Set
    </Button>
  );
}

/**
 * One always-visible inventory row plus its optional expanded inline editor
 * row. Env rows are read-only by design: the environment variable is
 * authoritative, so the row offers a lock explaining that instead of inert
 * mutation buttons.
 */
export function CredentialRow({
  busy,
  deprecatedReports,
  draftKey,
  draftMode,
  draftProfile,
  draftRegion,
  editing,
  highlightNonce,
  highlighted,
  onCancelEdit,
  onDraftKeyChange,
  onDraftModeChange,
  onDraftProfileChange,
  onDraftRegionChange,
  onOpenEditor,
  onRemove,
  onSave,
  slot,
  source,
  sourceState,
}: CredentialRowProps) {
  const fingerprint = fingerprintOf(source);
  const oauth = isOAuthSlot(slot);

  // Keyboard flow (BST-1362 review): when the inline editor closes — Escape,
  // Cancel, or a completed save — focus returns to the row's Set/Replace
  // trigger instead of falling to <body>. Only the true→false transition
  // focuses, so mounting a row never steals focus.
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(editing);

  // Cross-link landing (BST-1363): an Environment chip names a variable, and
  // the row it configures may be far down the table — so becoming the
  // highlighted row scrolls itself into view. Keyed on the nonce as well as
  // the flag so re-clicking the SAME chip scrolls again; clearing the
  // highlight never scrolls, and unrelated re-renders never yank the viewport
  // because neither value changes.
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  // biome-ignore lint/plugin: The scroll must follow the highlight PROPS changing — the trigger lives in a sibling section with no event this row can subscribe to — so reacting to the change is the correct tool, not an event handler.
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted, highlightNonce]);
  // biome-ignore lint/plugin: Focus restoration must follow EVERY close path — including non-local ones (save success, the slot becoming env on reload) that have no row-level event to hook — so reacting to the editing prop transition is the correct tool, not an event handler stand-in.
  useEffect(() => {
    if (wasEditingRef.current && !editing) {
      editorTriggerRef.current?.focus();
    }
    wasEditingRef.current = editing;
  }, [editing]);

  return (
    <>
      <TableRow
        className={highlighted ? 'bg-primary/10 ring-1 ring-primary/50' : undefined}
        data-highlighted={highlighted ? 'true' : undefined}
        data-testid={`credential-row-${slot.id}`}
        ref={rowRef}
      >
        <TableCell className="py-2">
          <ProviderNameCell slot={slot} />
        </TableCell>
        <TableCell className="py-2">
          {slot.envVar ? (
            <code
              className="break-all font-mono text-xs"
              data-testid={`credential-env-var-${slot.id}`}
            >
              {slot.envVar}
            </code>
          ) : (
            // A subscription slot has no env name at all — saying so beats an
            // empty cell the user would read as "not loaded yet".
            <span
              className="text-muted-foreground text-xs"
              data-testid={`credential-no-env-var-${slot.id}`}
            >
              Sign-in only — no environment variable
            </span>
          )}
          {deprecatedReports.map((report) => (
            <p
              className="mt-1 text-amber-700 text-xs dark:text-amber-500"
              data-testid={`credential-deprecated-env-${slot.id}`}
              key={report.envVar}
            >
              {/* Same sentence the Environment section renders — one string,
                  one rename target, so the two can never disagree. */}
              {deprecatedEnvVarMessage({
                envVar: report.envVar,
                replacement: report.replacement,
              })}
            </p>
          ))}
        </TableCell>
        <TableCell className="py-2">
          <CredentialStatusCell slot={slot} source={source} sourceState={sourceState} />
        </TableCell>
        <TableCell className="py-2">
          {fingerprint ? (
            <span
              className="text-muted-foreground text-xs"
              data-testid={`credential-fingerprint-${slot.id}`}
            >
              <span className="font-mono">…{fingerprint.last4}</span>
              {' · Saved '}
              {new Date(fingerprint.savedAt).toLocaleDateString()}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="py-2 text-right">
          <RowActions
            busy={busy}
            editorTriggerRef={editorTriggerRef}
            onOpenEditor={onOpenEditor}
            onRemove={onRemove}
            slot={slot}
            source={source}
            sourceState={sourceState}
          />
        </TableCell>
      </TableRow>
      {oauth ? (
        // Always rendered, never behind an expand: the personal-use terms must
        // be on screen BEFORE the user clicks Connect (OAuth legal gate,
        // constraint 4).
        <TableRow data-testid={`credential-oauth-notice-row-${slot.id}`}>
          <TableCell className="py-2" colSpan={CREDENTIAL_TABLE_COLUMN_COUNT}>
            <CredentialOAuthNotice slot={slot} />
          </TableCell>
        </TableRow>
      ) : null}
      {editing && !oauth ? (
        <TableRow data-testid={`credential-editor-row-${slot.id}`}>
          <TableCell className="py-2" colSpan={CREDENTIAL_TABLE_COLUMN_COUNT}>
            <CredentialRowEditor
              busy={busy}
              draftKey={draftKey}
              draftMode={draftMode}
              draftProfile={draftProfile}
              draftRegion={draftRegion}
              onCancel={onCancelEdit}
              onDraftKeyChange={onDraftKeyChange}
              onDraftModeChange={onDraftModeChange}
              onDraftProfileChange={onDraftProfileChange}
              onDraftRegionChange={onDraftRegionChange}
              onSave={onSave}
              slot={slot}
            />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
