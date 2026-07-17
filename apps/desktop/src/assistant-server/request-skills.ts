/**
 * Per-request Agent Skills resolution (desktop assistant server).
 *
 * Reads the renderer's `skillsPreference` (a PREFERENCE that can only REDUCE
 * the skill set — mirrors `subagentPersonasRequest`; malformed shapes are
 * dropped with a warn and the fail-safe default applies: master ON, nothing
 * disabled), then builds the TRUSTED `workspaceSkills` engine over the four
 * skills tiers (mounted roots + home dir). The caller strips any
 * client-supplied `workspaceSkills` before this runs — the engine is always
 * server-built, like `hookRunner`.
 *
 * The built-in local provider never gets an engine: the 2B on-device model's
 * context budget cannot afford skill payloads (mirrors the personas /
 * workspace-instructions / plan-mode local exclusions). The agent runtime
 * gates on provider too — this is the belt to that suspenders.
 */

import type {
  RuntimeData,
  SkillContentDeps,
  SkillScanDeps,
  SkillScanRoot,
  WorkspaceSkills,
} from '@brainstrike/agent';
import { createScannedWorkspaceSkills, scanSkills } from '@brainstrike/agent';
import type { SkillsContextRequest } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('AssistantSkills');

const FAIL_SAFE_PREFERENCE: SkillsContextRequest = {
  disabledSkillKeys: [],
  masterEnabled: true,
};

/**
 * Strictly parse the renderer-supplied skills preference. A malformed field is
 * DROPPED with a warn (never coerced) and the fail-safe default applies —
 * mirrors `readWorkspaceInstructionsPreference`.
 */
export function readSkillsPreference(value: unknown): SkillsContextRequest {
  if (value === undefined) {
    return FAIL_SAFE_PREFERENCE;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    logger.warn('Dropping malformed skills preference (not an object); using the default', {});
    return FAIL_SAFE_PREFERENCE;
  }
  const record = value as Record<string, unknown>;
  const masterEnabled = record['masterEnabled'];
  const disabledSkillKeys = record['disabledSkillKeys'];
  if (
    typeof masterEnabled !== 'boolean' ||
    !Array.isArray(disabledSkillKeys) ||
    !disabledSkillKeys.every((key) => typeof key === 'string')
  ) {
    logger.warn('Dropping malformed skills preference (bad field types); using the default', {});
    return FAIL_SAFE_PREFERENCE;
  }
  return { disabledSkillKeys: disabledSkillKeys as string[], masterEnabled };
}

export interface PrepareRequestSkillsParams {
  /** Injected fs surface (SecureRoot-backed in production, in-memory in tests). */
  readonly fs: SkillContentDeps;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
  readonly runtimeData: RuntimeData | undefined;
}

export interface PreparedRequestSkills {
  /** The server-built skills engine, or undefined when skills are off. */
  readonly workspaceSkills?: WorkspaceSkills;
}

/** Resolve the per-request skills engine from runtime data + preference. */
export function prepareRequestSkills(params: PrepareRequestSkillsParams): PreparedRequestSkills {
  const { fs, homedir, runtimeData } = params;
  if (runtimeData?.provider === 'local') {
    return {};
  }
  const preference = readSkillsPreference(runtimeData?.skillsPreference);
  if (!preference.masterEnabled) {
    return {};
  }
  const disabledKeys = new Set(preference.disabledSkillKeys);
  const roots: SkillScanRoot[] = (runtimeData?.workspaceRoots ?? [])
    .filter((root) => Boolean(root.path))
    .map((root) => ({ absPath: root.path, displayName: root.displayName, id: root.rootId }));
  const homeDir = homedir();
  const scanDeps: SkillScanDeps = { listDir: fs.listDir, readFile: fs.readFileText };
  const workspaceSkills = createScannedWorkspaceSkills({
    deps: fs,
    isEnabled: (skill) => !disabledKeys.has(skill.preferenceKey),
    scan: () => scanSkills({ homeDir, roots }, scanDeps),
  });
  return { workspaceSkills };
}
