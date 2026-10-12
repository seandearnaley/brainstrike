/**
 * Write/edit/stateful tool suites (BST-1980 C1, group C).
 *
 * A host call's context write-back crosses to Main as
 * `platform/workspace-context/{selection,tapestry}`, and Main delivers it to the
 * visible windows through `mainWorkspaceContextBroadcaster`
 * (`host-tool-services.ts` `serveContextDelivery`). This Main connection serves
 * exactly those two requests the same way, so a suite asserts the real
 * window delivery end to end; any other request fails loudly.
 */

import type { HostWorkspaceEdit } from '@brainstrike/agent-host';
import type { NativeEditCall } from '@brainstrike/host-capabilities/native-tools';
import {
  ContextSelectionDeliveryRequestSchema,
  ContextTapestryDeliveryRequestSchema,
} from '../../agent-host-platform/host-tool-wire';
import { mainWorkspaceContextBroadcaster } from '../../assistant-server/workspace-context-broadcast';
import type { HostMainRequest } from './_host-native-tools';

export const mainContextDeliveryRequest: HostMainRequest = async (method, input) => {
  switch (method) {
    case 'platform/workspace-context/selection': {
      const { payload } = ContextSelectionDeliveryRequestSchema.parse(input);
      return { notifiedWindowCount: await mainWorkspaceContextBroadcaster.selection(payload) };
    }
    case 'platform/workspace-context/tapestry': {
      const { payload } = ContextTapestryDeliveryRequestSchema.parse(input);
      return { notifiedWindowCount: await mainWorkspaceContextBroadcaster.tapestry(payload) };
    }
    default:
      throw new Error(`Unexpected Main request ${method}`);
  }
};

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
