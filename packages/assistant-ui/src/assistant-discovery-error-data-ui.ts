import type { AssistantDataUIProps } from '@assistant-ui/react';
import { SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME } from '@brainstrike/assistant-contract';
import { AssistantDiscoveryErrorNotice } from './assistant-discovery-error-notice';

export const assistantDiscoveryErrorDataUI = {
  name: SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME,
  render: AssistantDiscoveryErrorNotice,
} satisfies AssistantDataUIProps;
