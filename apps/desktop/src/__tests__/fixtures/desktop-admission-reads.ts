import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { z } from 'zod';
import type {
  DesktopAdmissionReads,
  DesktopTrustedRoots,
} from '../../agent-host-platform/desktop-run-admission';

const CapturedIntentSchema = z.record(z.string(), z.json());
/** A run's captured intent, as JSON the host protocol carries. */
export type CapturedIntent = z.output<typeof CapturedIntentSchema>;

/**
 * The intent a composer captures for a run, as `run/start` carries it: the
 * model, no native tools, and Skills and workspace instructions off.
 */
export function capturedIntent(options: {
  readonly agentLoop?: {
    readonly compactionTokenCap?: number;
    readonly inputTokenLimit?: number;
    readonly maxSteps?: number;
  };
  readonly model: string;
  readonly provider: string;
}): CapturedIntent {
  return CapturedIntentSchema.parse({
    ...(options.agentLoop ? { agentLoop: options.agentLoop } : {}),
    enabledNativeToolIds: [],
    modelConfiguration: { model: options.model, provider: options.provider },
    permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
    skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
    workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
  });
}

/**
 * Main's reads for a scenario's profile (BST-1930 stage e): every catalog
 * model enabled, no roots and no worktree service, unless the scenario says
 * otherwise.
 */
export function mainReads(overrides: Partial<DesktopAdmissionReads> = {}): DesktopAdmissionReads {
  return {
    acquireWorkspace: () => Promise.reject(new Error('This scenario binds no workspace')),
    catalogModel: async ({ provider }) => ({ isEnabled: true, providerId: provider, type: 'llm' }),
    liveWorkspaceRoots: async () => [],
    ...overrides,
  };
}

/** ADR-0032: a scenario's person trusts every folder it mounts, unless it says otherwise. */
export const everyRootTrusted: DesktopTrustedRoots = async (roots) => roots;
