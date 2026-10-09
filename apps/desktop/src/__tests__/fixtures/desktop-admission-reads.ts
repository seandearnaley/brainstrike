import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract';
import { z } from 'zod';
import type { DesktopAdmissionReads } from '../../agent-host-platform/desktop-run-admission';

type MemorySettings = typeof DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
const CapturedIntentSchema = z.record(z.string(), z.json());
/** A run's captured intent, as JSON the host protocol carries. */
export type CapturedIntent = z.output<typeof CapturedIntentSchema>;

/**
 * The intent a composer captures for a run, as `run/start` carries it: the
 * model, no native tools, Skills and workspace instructions off, and memory
 * off unless a scenario turns part of it on.
 */
export function capturedIntent(options: {
  readonly agentLoop?: { readonly inputTokenLimit?: number; readonly maxSteps?: number };
  readonly memorySettings?: {
    readonly observationalMemory?: Partial<MemorySettings['observationalMemory']>;
    readonly semanticRecall?: Partial<MemorySettings['semanticRecall']>;
  };
  readonly model: string;
  readonly provider: string;
}): CapturedIntent {
  return CapturedIntentSchema.parse({
    ...(options.agentLoop ? { agentLoop: options.agentLoop } : {}),
    enabledNativeToolIds: [],
    memoryOptions: {
      lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
      workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
    },
    memorySettings: {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      observationalMemory: {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
        enabled: false,
        ...options.memorySettings?.observationalMemory,
      },
      semanticRecall: {
        ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
        enabled: false,
        ...options.memorySettings?.semanticRecall,
      },
    },
    modelConfiguration: { model: options.model, provider: options.provider },
    permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
}

/**
 * Main's reads for a scenario's profile (BST-1930 stage e): every catalog
 * model enabled, no observer candidates, no recall embedder, no roots and no
 * worktree service, unless the scenario says otherwise.
 */
export function mainReads(overrides: Partial<DesktopAdmissionReads> = {}): DesktopAdmissionReads {
  return {
    acquireWorkspace: () => Promise.reject(new Error('This scenario binds no workspace')),
    catalogModel: async ({ provider }) => ({ isEnabled: true, providerId: provider }),
    enabledObservers: async () => [],
    liveWorkspaceRoots: async () => [],
    memoryVectors: async () => undefined,
    worktreesAvailable: async () => false,
    ...overrides,
  };
}

/** Main's reads for a scenario that admits no run: any admission read refuses. */
export function noRunAdmission(): DesktopAdmissionReads {
  const refuse = (): Promise<never> => Promise.reject(new Error('This scenario admits no run'));
  return {
    acquireWorkspace: refuse,
    catalogModel: refuse,
    enabledObservers: refuse,
    liveWorkspaceRoots: refuse,
    memoryVectors: refuse,
    worktreesAvailable: refuse,
  };
}
