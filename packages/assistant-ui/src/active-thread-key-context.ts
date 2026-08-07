import { createContext } from 'react';

/**
 * The active thread's stable key, provided by the panel root's ChatThreadUI
 * for message-level components (UserMessage's rewind action, AssistantMessage)
 * that need the CONVERSATION identity without prop-drilling through
 * assistant-ui's component maps. Lives in its own module so message components
 * extracted from the panel root never import the root back (module-scope
 * chunk-init cycle class — see verify-no-source-cycles).
 */
export const ActiveThreadKeyContext = createContext<string | undefined>(undefined);
