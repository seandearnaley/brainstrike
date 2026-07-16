import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect, useState } from 'react';

export interface ComposerDraftCommand {
  readonly id: string;
  readonly mode: 'append' | 'replace';
  readonly text: string;
}

export interface ComposerDraftCommandBridgeProps {
  /** Applies one explicit prompt-library command to the draft without sending it. */
  composerDraftCommand?: ComposerDraftCommand | undefined;
  /** Acknowledges a composer command only after its text is visible in the draft. */
  onComposerDraftCommandApplied?: ((commandId: string) => void) | undefined;
  /** Reports the live draft so prompt suggestions can use the user's actual context. */
  onComposerTextChange?: ((text: string) => void) | undefined;
}

export function useComposerDraftCommand({
  command,
  onApplied,
  onTextChange,
}: {
  command: ComposerDraftCommand | undefined;
  onApplied: ((commandId: string) => void) | undefined;
  onTextChange: ((text: string) => void) | undefined;
}): void {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const [appliedCommandIds] = useState(() => new Set<string>());

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- This is an intentional external-store bridge: prompt recall must observe assistant-ui's authoritative draft, including send/reset mutations that do not originate from the DOM input.
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

    const nextText =
      command.mode === 'append' && composerText.length > 0
        ? `${composerText}\n\n${command.text}`
        : command.text;
    aui.composer().setText(nextText);
    appliedCommandIds.add(command.id);
    onApplied?.(command.id);
  }, [appliedCommandIds, aui, command, composerText, onApplied]);
}

/** Render-nothing leaf that owns the composer-text subscription. */
export function ComposerDraftCommandBridge({
  composerDraftCommand,
  onComposerDraftCommandApplied,
  onComposerTextChange,
}: ComposerDraftCommandBridgeProps) {
  useComposerDraftCommand({
    command: composerDraftCommand,
    onApplied: onComposerDraftCommandApplied,
    onTextChange: onComposerTextChange,
  });
  return null;
}
