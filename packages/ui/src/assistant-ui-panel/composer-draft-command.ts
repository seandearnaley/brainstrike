import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect, useState } from 'react';

export interface ComposerDraftCommand {
  readonly id: string;
  readonly mode: 'append' | 'replace';
  readonly text: string;
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
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- The external command owner needs an acknowledgement only after assistant-ui accepts the text.
    onTextChange?.(nextText);
    onApplied?.(command.id);
  }, [appliedCommandIds, aui, command, composerText, onApplied, onTextChange]);
}
