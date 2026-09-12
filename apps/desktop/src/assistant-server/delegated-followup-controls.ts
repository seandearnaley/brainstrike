import type { DelegatedFollowupInput } from '@brainstrike/agent';
import type { DelegatedConversationScope } from '@brainstrike/db';

type Control = (
  scope: DelegatedConversationScope,
  threadId: string,
  input: DelegatedFollowupInput
) => Promise<void>;
const controls = new Map<string, Control>();

export function registerDesktopDelegatedFollowup(hostRunId: string, control: Control): () => void {
  if (controls.has(hostRunId)) {
    throw new Error('This host already owns child input delivery.');
  }
  controls.set(hostRunId, control);
  return () => {
    if (controls.get(hostRunId) === control) {
      controls.delete(hostRunId);
    }
  };
}

export async function sendDesktopDelegatedFollowup(
  hostRunId: string,
  scope: DelegatedConversationScope,
  threadId: string,
  input: DelegatedFollowupInput
): Promise<void> {
  const control = controls.get(hostRunId);
  if (!control) {
    throw new Error('The child execution owner is unavailable. Input was not replayed.');
  }
  await control(scope, threadId, input);
}
