import { describe, expect, it } from 'vitest';
import { parseWebAssistantRuntimeData } from '../web-assistant-runtime-schema';

/**
 * The runtime data the shared web client sent on a first-run Send (no folder
 * selected), captured from the running app. Web chat answered every such
 * request 400 while the server's hand-copied lists drifted from the shared
 * contract (`unconfigured`, BST-1335; desktop-only `subagentSettings`).
 */
const firstRunWebRequest = {
  agentLoop: { inputTokenLimit: 869_500 },
  enabledNativeToolIds: ['brainstrike.askUser', 'brainstrike.readWorkspaceFile'],
  model: 'gpt-5.6-terra',
  provider: 'openai',
  workspaceIndexEmbeddingSetId: '021b66ee-67f9-4de5-9dd9-d81d76949976',
  workspaceIndexingEnabled: true,
  workspaceIndexingMode: 'root-folder-cache',
  workspaceIndexingPaused: false,
  workspaceIndexStatusState: 'unconfigured',
};

describe('parseWebAssistantRuntimeData', () => {
  it('accepts the web client first-run request (no folder selected)', () => {
    expect(parseWebAssistantRuntimeData(firstRunWebRequest)).toMatchObject({ success: true });
  });
});
