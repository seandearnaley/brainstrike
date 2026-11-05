/**
 * ADR-0028 step 3b: a person's message that a running run reads at a step
 * passes what a run's own prompt passes at its start. Its UserPromptSubmit
 * hooks may block it, which fails the run with the hook's reason, or add
 * context; the files it mentions and the skills it activates are read as the
 * run's admission read its own prompt's. What they add rides in the message,
 * so the commit keeps it.
 */

import { refusalError } from '@brainstrike/assistant-contract';
import type { UserModelMessage } from 'ai';
import type { HostRunAdmission } from './ports.ts';
import type { HostEvent, HostParams } from './protocol.ts';
import { hostPersonInputMessage } from './turn-input.ts';

export interface HostReadPersonInput {
  /** What the run commits before the message: the mentioned files it could not read. */
  readonly events: readonly HostEvent[];
  /** Why the run fails once the message is committed: a hook's block, or a failed read. */
  readonly failure?: unknown;
  readonly message: UserModelMessage;
}

export async function hostReadPersonInput(
  admission: HostRunAdmission,
  runId: string,
  input: HostParams<'run/input'>
): Promise<HostReadPersonInput> {
  try {
    const gate = await admission.hooks?.userPromptSubmit(input.prompt);
    if (gate?.blocked) {
      return {
        events: [],
        failure: refusalError(
          'input',
          'hook.prompt-blocked',
          `The request was blocked by a hook: ${gate.reason}`
        ),
        message: hostPersonInputMessage(input),
      };
    }
    const read = await admission.readPromptContext?.(input.prompt);
    const hooked = gate?.additionalContext
      ? `UserPromptSubmit hook context:\n${gate.additionalContext}`
      : undefined;
    const context = [read?.context, hooked].filter(Boolean).join('\n\n');
    const failures = read?.referencedFileFailures ?? [];
    return {
      events:
        failures.length > 0
          ? [{ files: [...failures], runId, type: 'references.unavailable' }]
          : [],
      message: hostPersonInputMessage(input, context),
    };
  } catch (cause) {
    return { events: [], failure: cause, message: hostPersonInputMessage(input) };
  }
}
