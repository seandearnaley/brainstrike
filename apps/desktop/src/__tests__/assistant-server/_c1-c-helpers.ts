/** Write/edit/stateful tool suites (BST-1980 C1, group C). */

import type { HostWorkspaceEdit } from '@brainstrike/agent-host';
import type { NativeEditCall } from '@brainstrike/host-capabilities/native-tools';

/** One edit a file-mutation tool handed Core's tracker, with the call that opened it. */
export interface TrackedEdit {
  readonly call: NativeEditCall;
  readonly edit: HostWorkspaceEdit;
}

/**
 * The file-mutation tools' attribution port (`FileMutationPorts.edits`) reduced
 * to its observable contract: run the mutation, then record the edit and the
 * call (tool name, tool call id) it was opened for, as Core's tracker commits it.
 */
export function recordingEditsPort(): {
  readonly edits: (call: NativeEditCall) => {
    track<T>(edit: HostWorkspaceEdit, mutate: () => Promise<T>): Promise<T>;
  };
  readonly tracked: TrackedEdit[];
} {
  const tracked: TrackedEdit[] = [];
  return {
    edits: (call) => ({
      track: async (edit, mutate) => {
        try {
          return await mutate();
        } finally {
          tracked.push({ call, edit });
        }
      },
    }),
    tracked,
  };
}
