/** A full, non-default captured intent for the desktop host intent owner tests. */
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { PlatformClientConfigurationSchema } from '../../agent-host-platform/platform-wire';

export function desktopHostIntentFixture() {
  return PlatformClientConfigurationSchema.parse({
    agentLoop: { inputTokenLimit: 7000, maxSteps: 3 },
    enabledNativeToolIds: [],
    memoryOptions: {
      lastMessages: 1,
      workingMemory: { enabled: false, scope: 'thread', template: 'Owner template' },
    },
    memorySettings: {
      observationalMemory: {
        enabled: false,
        messageTokens: 1234,
        modelTarget: 'auto',
        observationTokens: 2345,
        retrievalMode: 'messages',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: null,
        enabled: false,
        messageRange: 0,
        scope: 'thread',
        topK: 2,
      },
    },
    modelConfiguration: {
      model: 'gpt-6-sol',
      modelSettings: { maxOutputTokens: 97, temperature: 0.31 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'low' } },
    },
    permissionPolicy: {
      perToolOverrides: { 'brainstrike.writeWorkspaceFile': 'deny' },
      policies: DEFAULT_PERMISSION_POLICIES,
      yolo: false,
    },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    subagents: {
      delegationEnabled: false,
      disabledPersonaIds: ['analyze'],
      settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxConcurrentWork: 2, maxDepth: 1 },
    },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
}
