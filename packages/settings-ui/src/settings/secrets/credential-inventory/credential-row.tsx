import type {
  DeprecatedEnvVarReport,
  ProviderKeySource,
  StoredKeyFingerprint,
} from '@brainstrike/assistant-contract';
import {
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
import { KeySourceBadge } from '../key-source-badge';
import type { CredentialSourceState } from '../provider-key-types';
import { CredentialRowEditor } from './credential-row-editor';
import type { CredentialSlot } from './credential-slots';

export const CREDENTIAL_TABLE_COLUMN_COUNT = 5;

interface CredentialRowProps {
  readonly busy: boolean;
  readonly deprecatedReports: readonly DeprecatedEnvVarReport[];
  readonly draftKey: string;
  readonly draftRegion: string;
  readonly editing: boolean;
  readonly onCancelEdit: () => void;
  readonly onDraftKeyChange: (value: string) => void;
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
      <span className="truncate font-medium">{slot.displayName}</span>
    </span>
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
  draftRegion,
  editing,
  onCancelEdit,
  onDraftKeyChange,
  onDraftRegionChange,
  onOpenEditor,
  onRemove,
  onSave,
  slot,
  source,
  sourceState,
}: CredentialRowProps) {
  const fingerprint = fingerprintOf(source);

  // Keyboard flow (BST-1362 review): when the inline editor closes — Escape,
  // Cancel, or a completed save — focus returns to the row's Set/Replace
  // trigger instead of falling to <body>. Only the true→false transition
  // focuses, so mounting a row never steals focus.
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(editing);
  // biome-ignore lint/plugin: Focus restoration must follow EVERY close path — including non-local ones (save success, the slot becoming env on reload) that have no row-level event to hook — so reacting to the editing prop transition is the correct tool, not an event handler stand-in.
  useEffect(() => {
    if (wasEditingRef.current && !editing) {
      editorTriggerRef.current?.focus();
    }
    wasEditingRef.current = editing;
  }, [editing]);

  return (
    <>
      <TableRow data-testid={`credential-row-${slot.id}`}>
        <TableCell className="py-2">
          <ProviderNameCell slot={slot} />
        </TableCell>
        <TableCell className="py-2">
          <code
            className="break-all font-mono text-xs"
            data-testid={`credential-env-var-${slot.id}`}
          >
            {slot.envVar}
          </code>
          {deprecatedReports.map((report) => (
            <p
              className="mt-1 text-amber-700 text-xs dark:text-amber-500"
              data-testid={`credential-deprecated-env-${slot.id}`}
              key={report.envVar}
            >
              {report.envVar} is set but no longer read — rename it to {report.replacement}.
            </p>
          ))}
        </TableCell>
        <TableCell className="py-2">
          {sourceState === 'loading' ? (
            <span
              className="block h-5 w-24 animate-pulse rounded bg-muted"
              data-testid={`credential-status-skeleton-${slot.id}`}
            />
          ) : (
            <KeySourceBadge
              source={source}
              sourceState={sourceState}
              testId={`credential-status-${slot.id}`}
            />
          )}
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
      {editing ? (
        <TableRow data-testid={`credential-editor-row-${slot.id}`}>
          <TableCell className="py-2" colSpan={CREDENTIAL_TABLE_COLUMN_COUNT}>
            <CredentialRowEditor
              busy={busy}
              draftKey={draftKey}
              draftRegion={draftRegion}
              onCancel={onCancelEdit}
              onDraftKeyChange={onDraftKeyChange}
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
