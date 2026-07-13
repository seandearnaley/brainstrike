/**
 * Subagent persona availability request for the assistant wire (desktop
 * data-stream only). Reads the subagent-personas preferences store and builds
 * the presence-means-non-default wire field: `undefined` at the defaults (the
 * field stays off the wire), on any other transport, or on web.
 */

import type { SubagentPersonasAvailabilityRequest } from '@brainstrike/assistant-contract';
import {
  buildSubagentPersonasAvailabilityRequest,
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '@brainstrike/preferences/stores/subagent-personas-store';
import { useMemo } from 'react';

export function useSubagentPersonasRequest(
  localChatTransport: string
): SubagentPersonasAvailabilityRequest | undefined {
  const delegationEnabled = useSubagentPersonasStore(subagentPersonasSelectors.delegationEnabled);
  const disabledPersonaIds = useSubagentPersonasStore(subagentPersonasSelectors.disabledPersonaIds);
  return useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return buildSubagentPersonasAvailabilityRequest({
      delegationEnabled,
      disabledPersonaIds,
    });
  }, [localChatTransport, delegationEnabled, disabledPersonaIds]);
}
