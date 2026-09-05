/**
 * `skills` IPC contract (BST-1648): Agent Skills discovery for the Settings →
 * Skills panel and the composer's "/" menu (`window.skills`). Pinned equal to
 * `SkillsBridge` in @brainstrike/assistant-contract below. PURE — bundled
 * into the preload and imported by main.
 */
import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import type { SkillsBridge } from '@brainstrike/assistant-contract/skills-bridge';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';

export const skillsContract = {
  scan: channel<[], SkillsScanResultSummary>({
    channel: DESKTOP_IPC_CHANNELS.skills.scan,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
} satisfies Contract;

export type SkillsBridgeDerivationProof = AssertTrue<
  BridgeMatches<typeof skillsContract, SkillsBridge>
>;
