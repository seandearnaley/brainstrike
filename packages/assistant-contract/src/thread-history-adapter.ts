import type { ThreadHistoryAdapter } from '@assistant-ui/react';

/**
 * Renderer history seam shared by assistant persistence and assistant-ui.
 * Keeping the alias here prevents the data package from depending on the
 * Brainstrike UI package.
 */
export type AssistantUiThreadHistoryAdapter = ThreadHistoryAdapter;

/** Native storage rows represented by one hydrated assistant message. */
export const NATIVE_MESSAGE_IDS_METADATA_KEY = 'brainstrikeNativeMessageIds';
