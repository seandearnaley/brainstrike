import { isValidAwsRegion } from '@brainstrike/assistant-contract';
import { Button, CopyTextButton, Input } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';
import type { CredentialSlot } from './credential-slots';

interface CredentialRowEditorProps {
  readonly busy: boolean;
  readonly draftKey: string;
  readonly draftRegion: string;
  readonly onCancel: () => void;
  readonly onDraftKeyChange: (value: string) => void;
  readonly onDraftRegionChange: (value: string) => void;
  readonly onSave: () => void;
  readonly slot: CredentialSlot;
}

/**
 * Registry-driven hint (BST-1349): keyNotes + keyFormatHint metadata, never a
 * `provider === '...'` branch. keyNotes is a complete sentence (registry
 * convention: ends with a period), so a single-space join cannot run on.
 */
function composeKeyHint(slot: CredentialSlot): string | null {
  const parts: string[] = [];
  if (slot.keyNotes) {
    parts.push(slot.keyNotes);
  }
  if (slot.keyFormatHint) {
    parts.push(`Keys look like ${slot.keyFormatHint}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The inline expanded editor for one credential slot — no modal, no dropdown.
 * Enter saves, Escape cancels (stopped so the surrounding settings dialog does
 * not close), and the secret input autofocuses on expand. The aws variant adds
 * a region field and saves a `{type:'aws', mode:'bearer'}` credential.
 */
export function CredentialRowEditor({
  busy,
  draftKey,
  draftRegion,
  onCancel,
  onDraftKeyChange,
  onDraftRegionChange,
  onSave,
  slot,
}: CredentialRowEditorProps) {
  const isAws = slot.authType === 'aws';
  // SECURITY (BST-1350 review, finding 1): the region is interpolated into
  // the Bedrock request hostname, so a non-region value must never reach the
  // keychain. The SHARED isValidAwsRegion (also enforced store-side in
  // isAwsCredential) gates Save and explains the expected shape inline.
  const trimmedRegion = draftRegion.trim();
  const regionInvalid = isAws && trimmedRegion.length > 0 && !isValidAwsRegion(trimmedRegion);
  const canSave =
    !busy && draftKey.trim().length > 0 && (!isAws || (trimmedRegion.length > 0 && !regionInvalid));
  const keyHint = composeKeyHint(slot);

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Escape cancels the editor WITHOUT closing the surrounding settings
  // dialog. Radix's DismissableLayer listens for Escape in the CAPTURE phase
  // on `document` and dismisses synchronously inside that handler, so the
  // ONLY handler that can preempt it is a window-capture listener (window
  // precedes document on the capture path) — a bubble-phase onKeyDown on this
  // container would run after the dialog had already dismissed. The listener
  // is SCOPED, never global (BST-1362 review): it acts only on Escape presses
  // originating INSIDE this editor (target containment), so an Escape pressed
  // anywhere else — another popover, the dialog itself — is left untouched
  // for its own surface to handle.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) {
        return;
      }
      const container = containerRef.current;
      if (!(container && event.target instanceof Node && container.contains(event.target))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', handleEscape, { capture: true });
    return () => window.removeEventListener('keydown', handleEscape, { capture: true });
  }, [busy, onCancel]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (canSave) {
        onSave();
      }
    }
  };

  return (
    <div className="space-y-2 py-1" data-testid={`credential-editor-${slot.id}`} ref={containerRef}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={isAws ? `${slot.displayName} bearer key` : `${slot.displayName} API key`}
          autoFocus={true}
          className="max-w-md flex-1"
          data-testid={`credential-key-input-${slot.id}`}
          onChange={(event) => onDraftKeyChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isAws ? `Enter ${slot.displayName} bearer key` : `Enter ${slot.displayName} API key`
          }
          type="password"
          value={draftKey}
        />
        {isAws ? (
          <Input
            aria-label={`${slot.displayName} AWS region`}
            className="w-40"
            data-testid={`credential-region-input-${slot.id}`}
            onChange={(event) => onDraftRegionChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="us-east-1"
            type="text"
            value={draftRegion}
          />
        ) : null}
        <Button
          data-testid={`credential-save-${slot.id}`}
          disabled={!canSave}
          onClick={onSave}
          size="sm"
        >
          Save
        </Button>
        <Button
          data-testid={`credential-cancel-${slot.id}`}
          disabled={busy}
          onClick={onCancel}
          size="sm"
          variant="secondary"
        >
          Cancel
        </Button>
      </div>
      {regionInvalid ? (
        <p
          className="text-destructive text-xs"
          data-testid={`credential-region-invalid-${slot.id}`}
        >
          Not a valid AWS region — use a region identifier like us-east-1.
        </p>
      ) : null}
      {keyHint ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid={`credential-editor-hint-${slot.id}`}
        >
          {keyHint}
        </p>
      ) : null}
      {slot.docsUrl ? (
        // An openExternal affordance DOES exist (app-shell's platform-bridge),
        // but settings-ui has no capability injection for it yet — the real
        // link arrives with the Provider Hub capability injection (BST-1358).
        // Until then the URL renders as selectable text with a copy button
        // rather than a dead anchor.
        <div className="flex items-center gap-1">
          <p
            className="select-all break-all text-muted-foreground text-xs"
            data-testid={`credential-editor-docs-${slot.id}`}
          >
            Get an API key: {slot.docsUrl}
          </p>
          <CopyTextButton
            ariaLabel={`Copy the ${slot.displayName} API key page URL`}
            text={slot.docsUrl}
          />
        </div>
      ) : null}
    </div>
  );
}
