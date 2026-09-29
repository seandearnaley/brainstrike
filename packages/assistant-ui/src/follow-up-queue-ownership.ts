import { createContext } from 'react';

/** Only the runtime owner may dispatch the session queue or offer its controls. */
export const FollowUpQueueOwnershipContext = createContext(true);
