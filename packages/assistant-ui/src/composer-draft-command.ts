import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect, useState } from 'react';

export interface ComposerDraftCommand {
  readonly id: string;
  /** `send` puts the text in the draft, then sends it once the composer can send. */
  readonly mode: 'append' | 'replace' | 'send';
  readonly text: string;
}

export interface ComposerDraftCommandBridgeProps {
  /** Applies one explicit composer command to the draft without sending it. */
  composerDraftCommand?: ComposerDraftCommand | undefined;
  /** The app's own send gate; a `send` command waits behind it with its text in the draft. */
  isComposerDisabled?: boolean | undefined;
  /** Acknowledges a composer command only after its text is visible in the draft. */
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  /** Reports the live draft so slash commands can read the arguments typed after them. */
  onComposerTextChange?: ((text: string) => void) | undefined;
}

/**
 * One step of a `send` command: stage its text, see it land in the draft, then
 * send once the composer can. A draft edited after the text landed is the
 * person's, so the command ends unsent.
 */
function advanceSendCommand(
  command: ComposerDraftCommand,
  step: {
    readonly canSend: boolean;
    readonly composerText: string;
    readonly landed: Set<string>;
    readonly onDone: () => void;
    readonly send: () => void;
    readonly setText: (text: string) => void;
    readonly staged: Set<string>;
  }
): void {
  if (!step.staged.has(command.id)) {
    step.staged.add(command.id);
    step.setText(command.text);
    return;
  }
  if (step.composerText !== command.text) {
    if (step.landed.has(command.id)) {
      step.onDone();
    }
    return;
  }
  step.landed.add(command.id);
  // A gate (history loading, no provider…) shows its reason; the text waits in the draft.
  if (step.canSend) {
    step.send();
    step.onDone();
  }
}

function useComposerDraftCommand({
  command,
  isComposerDisabled,
  onApplied,
  onTextChange,
}: {
  command: ComposerDraftCommand | undefined;
  isComposerDisabled: boolean;
  onApplied: ((commandId: string) => void) | undefined;
  onTextChange: ((text: string) => void) | undefined;
}): void {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const canSend = useAuiState((state) => state.composer.canSend);
  const [appliedCommandIds] = useState(() => new Set<string>());
  const [stagedCommandIds] = useState(() => new Set<string>());
  const [landedCommandIds] = useState(() => new Set<string>());

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- This is an intentional external-store bridge: slash-command expansion must observe assistant-ui's authoritative draft, including send/reset mutations that do not originate from the DOM input.
    onTextChange?.(composerText);
  }, [composerText, onTextChange]);

  useEffect(() => {
    if (!command || appliedCommandIds.has(command.id)) {
      return;
    }
    // react-doctor-disable-next-line react-doctor/no-event-handler -- This effect synchronizes a thread-scoped external command; there is no local DOM event to handle.
    if (!command.text.trim()) {
      throw new Error('Composer draft commands require non-whitespace text.');
    }

    if (command.mode === 'send') {
      advanceSendCommand(command, {
        canSend: canSend && !isComposerDisabled,
        composerText,
        landed: landedCommandIds,
        onDone: () => {
          appliedCommandIds.add(command.id);
          onApplied?.(command.id);
        },
        send: () => aui.composer().send(),
        setText: (text) => aui.composer().setText(text),
        staged: stagedCommandIds,
      });
      return;
    }

    const nextText =
      command.mode === 'append' && composerText.length > 0
        ? `${composerText}\n\n${command.text}`
        : command.text;
    aui.composer().setText(nextText);
    appliedCommandIds.add(command.id);
    onApplied?.(command.id);
  }, [
    appliedCommandIds,
    aui,
    canSend,
    command,
    composerText,
    isComposerDisabled,
    landedCommandIds,
    onApplied,
    stagedCommandIds,
  ]);
}

/** Render-nothing leaf that owns the composer-text subscription. */
export function ComposerDraftCommandBridge({
  composerDraftCommand,
  isComposerDisabled = false,
  onComposerDraftCommandApplied,
  onComposerTextChange,
}: ComposerDraftCommandBridgeProps) {
  useComposerDraftCommand({
    command: composerDraftCommand,
    isComposerDisabled,
    onApplied: onComposerDraftCommandApplied,
    onTextChange: onComposerTextChange,
  });
  return null;
}
