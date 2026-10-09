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
  ScannedSkill,
  ScannedWorkspaceSkills,
  SkillContentDeps,
  SkillScanDeps,
  SkillScanResult,
  SkillScanRoot,
} from '@brainstrike/agent';
import { createScannedWorkspaceSkills, MAX_SKILL_FILE_BYTES, scanSkills } from '@brainstrike/agent';
import type { SkillsContextRequest } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

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
  readonly workspaceSkills?: ScannedWorkspaceSkills;
}

interface RequestSkillSet {
  readonly isEnabled: (skill: ScannedSkill) => boolean;
  readonly scan: () => SkillScanResult;
}

/** The request's skill scan and enabled filter, or undefined when skills are off. */
function requestSkillSet(params: PrepareRequestSkillsParams): RequestSkillSet | undefined {
  const { fs, homedir, runtimeData } = params;
  if (runtimeData?.provider === 'local') {
    return;
  }
  const preference = readSkillsPreference(runtimeData?.skillsPreference);
  if (!preference.masterEnabled) {
    return;
  }
  const disabledKeys = new Set(preference.disabledSkillKeys);
  const roots: SkillScanRoot[] = (runtimeData?.workspaceRoots ?? [])
    .filter((root) => Boolean(root.path))
    .map((root) => ({ absPath: root.path, displayName: root.displayName, id: root.rootId }));
  const homeDir = homedir();
  // SKILL.md scan reads pre-bound at the tight scan ceiling (4x the 64K char
  // cap) so an oversized file is rejected BEFORE its bytes enter main-process
  // memory; reference/asset reads keep the larger content ceilings.
  const scanDeps: SkillScanDeps = {
    listDir: fs.listDir,
    readFile: (absFile) => fs.readFileText(absFile, MAX_SKILL_FILE_BYTES),
  };
  return {
    isEnabled: (skill) => !disabledKeys.has(skill.preferenceKey),
    scan: () => scanSkills({ homeDir, roots }, scanDeps),
  };
}

/** Resolve the per-request skills engine from runtime data + preference. */
export function prepareRequestSkills(params: PrepareRequestSkillsParams): PreparedRequestSkills {
  const set = requestSkillSet(params);
  return set ? { workspaceSkills: createScannedWorkspaceSkills({ deps: params.fs, ...set }) } : {};
}

export interface PreparedAdmittedSkills extends PreparedRequestSkills {
  /** The enabled skills of the run's one scan, admitted to the desktop agent host. */
  readonly skills?: readonly ScannedSkill[];
}

/**
 * One scan for a host run: Main's prompt engine reads it, and its enabled
 * skills (paths, frontmatter and SKILL.md instructions) are what the agent
 * host's skill tools may activate.
 */
export function prepareAdmittedSkills(params: PrepareRequestSkillsParams): PreparedAdmittedSkills {
  const set = requestSkillSet(params);
  if (!set) {
    return {};
  }
  const scanned = set.scan();
  return {
    skills: scanned.skills.filter(set.isEnabled),
    workspaceSkills: createScannedWorkspaceSkills({
      deps: params.fs,
      isEnabled: set.isEnabled,
      scan: () => scanned,
    }),
  };
}

/**
 * The agent host's engine over the admitted skills: it never scans; it reads
 * their references, scripts and assets through its own secure fs.
 */
export function admittedWorkspaceSkills(
  skills: readonly ScannedSkill[],
  fs: SkillContentDeps
): ScannedWorkspaceSkills {
  return createScannedWorkspaceSkills({
    deps: fs,
    scan: () => ({ entries: skills.map((skill) => ({ skill, status: 'ok' as const })), skills }),
  });
}
