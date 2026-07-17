/**
 * Agent Skills discovery (SKILL.md scanning).
 *
 * Scans skill directories from four location tiers, in PRIORITY order
 * (highest first, first-NAME-wins dedupe):
 *   1. `<root>/.brainstrike/skills/`   (every mounted root, in mounted order)
 *   2. `~/.brainstrike/skills/`
 *   3. `<root>/.claude/skills/`        (Claude Code compat)
 *   4. `~/.claude/skills/`
 *
 * A skill is a DIRECTORY whose immediate child `SKILL.md` carries valid YAML
 * frontmatter per the Agent Skills spec. The scan is FLAT (skill dirs sit
 * directly under a skills dir — the spec's layout; nested groups are not a
 * thing) and BOUNDED (per-file char/byte caps, a total-skills cap) because
 * skill files are UNTRUSTED repo content. Malformed skills yield visible
 * `invalid` entries with the exact validation errors; name collisions yield
 * visible `shadowed` entries pointing at the winner — never a silent drop.
 *
 * The filesystem is dependency-injected (the same `listDir`/`readFile` shape
 * as the desktop user-slash-commands loader, so the desktop reuses its
 * SecureRoot-backed adapter) — tier/priority/collision logic is unit-testable
 * without disk.
 */

import { deriveSkillPreferenceKey, type SkillSourceTier } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import { parseSkillMarkdown } from './skill-frontmatter';
import { validateSkillMetadata } from './skill-validation';

const logger = createLogger('SkillScan');

const SKILLS_SUBPATHS = {
  brainstrike: ['.brainstrike', 'skills'],
  claude: ['.claude', 'skills'],
} as const;

/**
 * Per-file SKILL.md size cap. Skill files are UNTRUSTED repo content, so their
 * bytes are bounded before they enter main-process memory (mirrors the
 * user-commands loader). The spec recommends <5k tokens (~20K chars); a
 * SKILL.md over this cap is not a skill — it yields a visible `invalid` entry.
 */
export const MAX_SKILL_FILE_CHARS = 64_000;

/**
 * Coarse BYTE ceiling for the real-disk reader's pre-read guard (4× the char
 * cap: a file at/under the character cap can never exceed it — see the
 * user-commands loader for the bytes-vs-chars rationale).
 */
export const MAX_SKILL_FILE_BYTES = MAX_SKILL_FILE_CHARS * 4;

/** Hard cap on ACCEPTED skills per scan (abuse/DoS bound). */
export const MAX_SKILLS = 200;

/** Max directory entries inspected per skills dir (traversal bound). */
export const MAX_SKILL_DIR_ENTRIES = 512;

export interface SkillScanRoot {
  /** Absolute filesystem path of the mounted root. */
  readonly absPath: string;
  /** The root's display name (Settings grouping). */
  readonly displayName: string;
  /** The DB `roots.id` — durable identity, never a raw path. */
  readonly id: string;
}

export interface SkillDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

export type SkillReadResult =
  | { readonly content: string; readonly ok: true }
  | { readonly ok: false; readonly reason: 'oversized' | 'unreadable' };

/** Injected fs surface — the same shape as the user-slash-commands loader. */
export interface SkillScanDeps {
  readonly listDir: (
    absDir: string,
    containmentRoot: string,
    maxEntries: number
  ) => {
    readonly entries: readonly SkillDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null;
  readonly readFile: (absFile: string) => SkillReadResult;
}

export interface SkillScanInput {
  readonly homeDir: string;
  readonly roots: readonly SkillScanRoot[];
}

/** A fully parsed, valid skill in scan-priority order. */
export interface ScannedSkill {
  readonly compatibility?: unknown;
  /** The containment root the skill's files must be read within. */
  readonly containmentRoot: string;
  readonly description: string;
  readonly dirAbsPath: string;
  readonly dirName: string;
  readonly instructions: string;
  readonly license?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
  /** Durable enable/disable key ({@link deriveSkillPreferenceKey}). */
  readonly preferenceKey: string;
  readonly sourceRootDisplayName?: string;
  /** Owning DB `roots.id` for project tiers; absent for global tiers. */
  readonly sourceRootId?: string;
  readonly tier: SkillSourceTier;
  /** Spec default: true. */
  readonly userInvocable: boolean;
  /** Non-fatal spec warnings (recommended-size overruns). */
  readonly warnings: readonly string[];
}

export type SkillScanEntry =
  | {
      readonly shadowedBy: { readonly absPath: string; readonly tier: SkillSourceTier };
      readonly skill: ScannedSkill;
      readonly status: 'shadowed';
    }
  | {
      readonly absPath: string;
      readonly dirName: string;
      readonly errors: readonly string[];
      readonly name?: string;
      readonly sourceRootDisplayName?: string;
      readonly sourceRootId?: string;
      readonly status: 'invalid';
      readonly tier: SkillSourceTier;
    }
  | { readonly skill: ScannedSkill; readonly status: 'ok' };

export interface SkillScanResult {
  /** Every discovered candidate in scan-priority order (ok/invalid/shadowed). */
  readonly entries: readonly SkillScanEntry[];
  /** The winning valid skills, in scan-priority order. */
  readonly skills: readonly ScannedSkill[];
}

// App-lifetime warn-once sets (mirrors the user-commands loader). Reset in
// tests via __resetSkillScanWarningsForTests.
const warnedCollisionNames = new Set<string>();
let warnedCountCapReached = false;

export function __resetSkillScanWarningsForTests(): void {
  warnedCollisionNames.clear();
  warnedCountCapReached = false;
}

function warnCountCapReached(): void {
  if (warnedCountCapReached) {
    return;
  }
  warnedCountCapReached = true;
  logger.warn('Skill count cap reached; ignoring the rest', { cap: MAX_SKILLS });
}

function warnDuplicate(name: string, dropped: string, kept: string): void {
  if (warnedCollisionNames.has(name)) {
    return;
  }
  warnedCollisionNames.add(name);
  logger.warn('Duplicate skill name; keeping the higher-priority skill', {
    droppedPath: dropped,
    keptPath: kept,
    name,
  });
}

function joinPath(base: string, segments: readonly string[]): string {
  return [base.replace(/\/+$/, ''), ...segments].join('/');
}

interface ScanSource {
  readonly containmentRoot: string;
  readonly sourceRootDisplayName?: string;
  readonly sourceRootId?: string;
  readonly tier: SkillSourceTier;
}

interface ParseOutcome {
  readonly errors?: readonly string[];
  readonly name?: string;
  readonly skill?: ScannedSkill;
}

/** Read + parse + validate one skill directory's SKILL.md. */
function parseSkillDirectory(
  dirAbsPath: string,
  dirName: string,
  source: ScanSource,
  deps: SkillScanDeps
): ParseOutcome {
  const skillFileAbsPath = joinPath(dirAbsPath, ['SKILL.md']);
  const read = deps.readFile(skillFileAbsPath);
  if (!read.ok) {
    return {
      errors: [
        read.reason === 'oversized'
          ? `SKILL.md exceeds the ${MAX_SKILL_FILE_CHARS.toLocaleString()}-character cap`
          : 'Failed to read SKILL.md',
      ],
    };
  }
  if (read.content.length > MAX_SKILL_FILE_CHARS) {
    return {
      errors: [
        `SKILL.md exceeds the ${MAX_SKILL_FILE_CHARS.toLocaleString()}-character cap (${read.content.length.toLocaleString()} chars)`,
      ],
    };
  }
  const parsed = parseSkillMarkdown(read.content);
  if (!parsed.ok) {
    return { errors: [parsed.error] };
  }
  const frontmatter = parsed.frontmatter;
  const parsedName = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : undefined;
  const validation = validateSkillMetadata(frontmatter, dirName, parsed.body);
  if (!validation.valid) {
    return { errors: validation.errors, ...(parsedName ? { name: parsedName } : {}) };
  }
  const name = frontmatter['name'] as string;
  const skill: ScannedSkill = {
    ...(frontmatter['compatibility'] === undefined
      ? {}
      : { compatibility: frontmatter['compatibility'] }),
    containmentRoot: source.containmentRoot,
    description: frontmatter['description'] as string,
    dirAbsPath,
    dirName,
    instructions: parsed.body,
    ...(typeof frontmatter['license'] === 'string' ? { license: frontmatter['license'] } : {}),
    ...(frontmatter['metadata'] && typeof frontmatter['metadata'] === 'object'
      ? { metadata: frontmatter['metadata'] as Record<string, unknown> }
      : {}),
    name,
    preferenceKey: deriveSkillPreferenceKey({
      name,
      ...(source.sourceRootId ? { sourceRootId: source.sourceRootId } : {}),
    }),
    ...(source.sourceRootDisplayName
      ? { sourceRootDisplayName: source.sourceRootDisplayName }
      : {}),
    ...(source.sourceRootId ? { sourceRootId: source.sourceRootId } : {}),
    tier: source.tier,
    userInvocable: frontmatter['user-invocable'] !== false,
    warnings: validation.warnings,
  };
  return { name, skill };
}

function ingestSkillsDirectory(
  skillsDir: string,
  source: ScanSource,
  deps: SkillScanDeps,
  winnersByName: Map<string, ScannedSkill>,
  entries: SkillScanEntry[]
): void {
  const listing = deps.listDir(skillsDir, source.containmentRoot, MAX_SKILL_DIR_ENTRIES);
  if (!listing) {
    return;
  }
  // Stable order within a directory so first-name-wins is deterministic.
  const candidates = listing.entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const dirName of candidates) {
    const dirAbsPath = joinPath(skillsDir, [dirName]);
    const childListing = deps.listDir(dirAbsPath, source.containmentRoot, MAX_SKILL_DIR_ENTRIES);
    const hasSkillFile = childListing?.entries.some(
      (entry) => entry.isFile && entry.name === 'SKILL.md'
    );
    if (!hasSkillFile) {
      // A directory without SKILL.md is simply not a skill (spec layout).
      continue;
    }

    const acceptedCount = winnersByName.size;
    if (acceptedCount >= MAX_SKILLS) {
      warnCountCapReached();
      return;
    }

    const outcome = parseSkillDirectory(dirAbsPath, dirName, source, deps);
    if (outcome.errors) {
      logger.error('Skipping invalid skill', { errors: outcome.errors, path: dirAbsPath });
      entries.push({
        absPath: dirAbsPath,
        dirName,
        errors: outcome.errors,
        ...(outcome.name ? { name: outcome.name } : {}),
        ...(source.sourceRootDisplayName
          ? { sourceRootDisplayName: source.sourceRootDisplayName }
          : {}),
        ...(source.sourceRootId ? { sourceRootId: source.sourceRootId } : {}),
        status: 'invalid',
        tier: source.tier,
      });
      continue;
    }
    const skill = outcome.skill as ScannedSkill;
    const winner = winnersByName.get(skill.name);
    if (winner) {
      warnDuplicate(skill.name, skill.dirAbsPath, winner.dirAbsPath);
      entries.push({
        shadowedBy: { absPath: winner.dirAbsPath, tier: winner.tier },
        skill,
        status: 'shadowed',
      });
      continue;
    }
    winnersByName.set(skill.name, skill);
    entries.push({ skill, status: 'ok' });
  }
}

/**
 * Discover every skill across the four location tiers. Returns all candidate
 * entries (ok/invalid/shadowed) plus the winning valid skills, both in
 * discovery (priority) order.
 */
export function scanSkills(input: SkillScanInput, deps: SkillScanDeps): SkillScanResult {
  const winnersByName = new Map<string, ScannedSkill>();
  const entries: SkillScanEntry[] = [];

  // Tier 1: <root>/.brainstrike/skills (mounted order).
  for (const root of input.roots) {
    ingestSkillsDirectory(
      joinPath(root.absPath, SKILLS_SUBPATHS.brainstrike),
      {
        containmentRoot: root.absPath,
        sourceRootDisplayName: root.displayName,
        sourceRootId: root.id,
        tier: 'root-brainstrike',
      },
      deps,
      winnersByName,
      entries
    );
  }
  // Tier 2: ~/.brainstrike/skills.
  ingestSkillsDirectory(
    joinPath(input.homeDir, SKILLS_SUBPATHS.brainstrike),
    { containmentRoot: input.homeDir, tier: 'global-brainstrike' },
    deps,
    winnersByName,
    entries
  );
  // Tier 3: <root>/.claude/skills (mounted order).
  for (const root of input.roots) {
    ingestSkillsDirectory(
      joinPath(root.absPath, SKILLS_SUBPATHS.claude),
      {
        containmentRoot: root.absPath,
        sourceRootDisplayName: root.displayName,
        sourceRootId: root.id,
        tier: 'root-claude',
      },
      deps,
      winnersByName,
      entries
    );
  }
  // Tier 4: ~/.claude/skills.
  ingestSkillsDirectory(
    joinPath(input.homeDir, SKILLS_SUBPATHS.claude),
    { containmentRoot: input.homeDir, tier: 'global-claude' },
    deps,
    winnersByName,
    entries
  );

  return {
    entries,
    skills: entries
      .filter((entry): entry is Extract<SkillScanEntry, { status: 'ok' }> => entry.status === 'ok')
      .map((entry) => entry.skill),
  };
}
