import { createLogger } from '@brainstrike/utils/logger';

// createLogger is scope-cached, so every module asking for this scope gets the
// SAME instance — including the integration tests that vi.spyOn the
// desktopAssistantServerLogger export on the assistant-server root. This module
// makes that identity provable rather than incidental (BST-975 seam map).
export const desktopAssistantServerLogger = createLogger('DesktopAssistantServer');
