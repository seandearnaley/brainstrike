/**
 * Subagent persona availability request for the assistant wire (desktop
 * assistant server only). Reads the subagent-personas preferences store and
 * builds the presence-means-non-default wire field: `undefined` at the
 * defaults (the field stays off the wire) or anywhere without that server.
 */

import {
  buildSubagentPersonasAvailabilityRequest,
  subagentPersonasSelectors,
  useSubagentPersonasStore,
} from '@brainstrike/app-state/stores/subagent-personas-store';
import type { SubagentPersonasAvailabilityRequest } from '@brainstrike/assistant-contract';
import { useMemo } from 'react';

export function useSubagentPersonasRequest(
  assistantServerAvailable: boolean
): SubagentPersonasAvailabilityRequest | undefined {
  const delegationEnabled = useSubagentPersonasStore(subagentPersonasSelectors.delegationEnabled);
  const disabledPersonaIds = useSubagentPersonasStore(subagentPersonasSelectors.disabledPersonaIds);
  return useMemo(() => {
    if (!assistantServerAvailable) {
      return;
    }
    return buildSubagentPersonasAvailabilityRequest({
      delegationEnabled,
      disabledPersonaIds,
    });
  }, [assistantServerAvailable, delegationEnabled, disabledPersonaIds]);
}
