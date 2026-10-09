import type { AssistantProviderSource } from './hooks/assistant-provider-source';

/** A child conversation's composer discovers its providers like the desktop root's. */
export const CHILD_PROVIDER_SOURCE: AssistantProviderSource = { kind: 'discovery' };
