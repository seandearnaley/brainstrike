/**
 * ScannedWorkspaceSkills — brainstrike's implementation of Mastra's
 * `WorkspaceSkills` interface (the exported extension seam; Mastra's own
 * `WorkspaceSkillsImpl` is not public) over the bounded {@link scanSkills}
 * output.
 *
 * One parser, one engine: the same scan that feeds the Settings panel serves
 * Mastra's canonical `createSkillTools` and `SkillsProcessor`, so UI status
 * and live agent behavior can never diverge. All file access goes through the
 * injected deps (SecureRoot-backed on desktop): reference/script/asset reads
 * are containment-checked (no `..`, no absolute paths) and size-bounded, and
 * disabled skills are invisible everywhere (list/get/has/search/reads).
 *
 * Lifetime: one engine per assistant request. The initial scan is lazy
 * (`maybeRefresh()`/first use), `refresh()` re-scans; there are no fs watchers
 * (mirrors the user-commands loader's no-polling posture).
 */

import { createLogger } from '@brainstrike/utils/logger';
import type { Skill, SkillMetadata, WorkspaceSkills } from '@mastra/core/skills';
import type { ScannedSkill, SkillDirEntry, SkillReadResult, SkillScanResult } from './skill-scan';

const logger = createLogger('WorkspaceSkills');

// Mastra exports the WorkspaceSkills interface but not its search option/result
// types — derive them from the interface so they can never drift from it.
type SkillSearchOptions = NonNullable<Parameters<WorkspaceSkills['search']>[1]>;
type SkillSearchResult = Awaited<ReturnType<WorkspaceSkills['search']>>[number];

/** Per-file cap for reference/script text reads served to skill tools. */
export const MAX_SKILL_CONTENT_FILE_CHARS = 256_000;
/** Per-file cap for asset byte reads. */
export const MAX_SKILL_ASSET_BYTES = 1_048_576;
/** Traversal bounds for references/scripts/assets listings per skill. */
const MAX_LISTING_ENTRIES = 200;
const MAX_LISTING_DEPTH = 5;
/** Default and cap for search results. */
const DEFAULT_SEARCH_TOP_K = 5;
const MAX_SEARCH_TOP_K = 20;
/** Cap on the snippet length of one search result line. */
const MAX_SEARCH_SNIPPET_CHARS = 300;

/** Injected fs surface for serving skill content (desktop: SecureRoot-backed). */
export interface SkillContentDeps {
  readonly listDir: (
    absDir: string,
    containmentRoot: string,
    maxEntries: number
  ) => {
    readonly entries: readonly SkillDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null;
  readonly readFileBytes: (
    absFile: string
  ) =>
    | { readonly content: Uint8Array; readonly ok: true }
    | { readonly ok: false; readonly reason: 'oversized' | 'unreadable' };
  /**
   * Bounded text read. `maxBytes` is the caller's PRE-READ ceiling (the
   * desktop adapter enforces it before pulling bytes into main-process
   * memory); a file above it reports `oversized`. Callers still apply their
   * own authoritative character caps on the returned content.
   */
  readonly readFileText: (absFile: string, maxBytes?: number) => SkillReadResult;
}

export interface ScannedWorkspaceSkillsConfig {
  readonly deps: SkillContentDeps;
  /**
   * Per-request enablement filter (skills preference). A disabled skill is
   * invisible to the model and the tools — activation of a disabled skill
   * reports "not found" with the enabled list. Absent ⇒ everything enabled.
   */
  readonly isEnabled?: (skill: ScannedSkill) => boolean;
  /** Fresh bounded scan (closes over roots/home + scan deps at the caller). */
  readonly scan: () => SkillScanResult;
}

const SKILL_SUBDIRS = ['references', 'scripts', 'assets'] as const;
type SkillSubdir = (typeof SKILL_SUBDIRS)[number];

interface SkillListings {
  readonly assets: readonly string[];
  readonly references: readonly string[];
  readonly scripts: readonly string[];
}

function joinPath(base: string, segments: readonly string[]): string {
  return [base.replace(/\/+$/, ''), ...segments].join('/');
}

/**
 * Validate a tool-supplied relative path: no absolute paths, no backslashes,
 * no `..`/empty segments. Returns the clean segments or null (refused).
 */
function sanitizeRelativePath(relPath: string): readonly string[] | null {
  if (relPath.length === 0 || relPath.startsWith('/') || relPath.includes('\\')) {
    return null;
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return null;
    }
  }
  return segments;
}

/**
 * Recursively collect files under one skill subdir (references/scripts/assets),
 * bounded by {@link MAX_LISTING_DEPTH} and {@link MAX_LISTING_ENTRIES} — a cap
 * hit is logged, never a silent partial that pretends to be complete.
 */
function collectSubdirFiles(
  deps: SkillContentDeps,
  skill: ScannedSkill,
  subdir: SkillSubdir
): readonly string[] {
  const files: string[] = [];
  const walk = (dirPath: string, relativeSegments: readonly string[], depth: number): void => {
    if (depth > MAX_LISTING_DEPTH || files.length >= MAX_LISTING_ENTRIES) {
      return;
    }
    const listing = deps.listDir(dirPath, skill.containmentRoot, MAX_LISTING_ENTRIES);
    if (!listing) {
      return;
    }
    for (const entry of listing.entries) {
      if (files.length >= MAX_LISTING_ENTRIES) {
        logger.warn('Skill listing cap reached; ignoring further files', {
          cap: MAX_LISTING_ENTRIES,
          skill: skill.name,
          subdir,
        });
        return;
      }
      if (entry.isDirectory) {
        walk(joinPath(dirPath, [entry.name]), [...relativeSegments, entry.name], depth + 1);
      } else if (entry.isFile) {
        files.push([...relativeSegments, entry.name].join('/'));
      }
    }
  };
  walk(joinPath(skill.dirAbsPath, [subdir]), [], 0);
  return files;
}

/**
 * Score one text (SKILL.md instructions or a reference file) against the query
 * terms, appending a result per matching line.
 */
function appendLineMatches(args: {
  readonly results: SkillSearchResult[];
  readonly skill: ScannedSkill;
  readonly source: string;
  readonly terms: readonly string[];
  readonly text: string;
}): void {
  const lines = args.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lowered = line.toLowerCase();
    const matched = args.terms.filter((term) => lowered.includes(term));
    if (matched.length === 0) {
      continue;
    }
    args.results.push({
      content: line.trim().slice(0, MAX_SEARCH_SNIPPET_CHARS),
      lineRange: { end: index + 1, start: index + 1 },
      score: matched.length,
      skillName: args.skill.name,
      skillPath: args.skill.dirAbsPath,
      source: args.source,
    });
  }
}

/** Create a {@link WorkspaceSkills} engine over the bounded skills scan. */
export function createScannedWorkspaceSkills(
  config: ScannedWorkspaceSkillsConfig
): WorkspaceSkills {
  const { deps, isEnabled, scan } = config;
  let scanned: SkillScanResult | null = null;
  const listingsCache = new Map<string, SkillListings>();

  function ensureScanned(): SkillScanResult {
    if (!scanned) {
      scanned = scan();
    }
    return scanned;
  }

  function enabledSkills(): readonly ScannedSkill[] {
    return ensureScanned().skills.filter((skill) => (isEnabled ? isEnabled(skill) : true));
  }

  /** Resolve a tool-supplied identifier: skill name, dir path, or SKILL.md path. */
  function resolveSkill(identifier: string): ScannedSkill | null {
    const normalized = identifier.endsWith('/SKILL.md')
      ? identifier.slice(0, -'/SKILL.md'.length)
      : identifier;
    for (const skill of enabledSkills()) {
      if (skill.name === normalized || skill.dirAbsPath === normalized) {
        return skill;
      }
    }
    return null;
  }

  function listSubdir(skill: ScannedSkill, subdir: SkillSubdir): readonly string[] {
    return collectSubdirFiles(deps, skill, subdir);
  }

  function listings(skill: ScannedSkill): SkillListings {
    const cached = listingsCache.get(skill.dirAbsPath);
    if (cached) {
      return cached;
    }
    const fresh: SkillListings = {
      assets: listSubdir(skill, 'assets'),
      references: listSubdir(skill, 'references'),
      scripts: listSubdir(skill, 'scripts'),
    };
    listingsCache.set(skill.dirAbsPath, fresh);
    return fresh;
  }

  function toMetadata(skill: ScannedSkill): SkillMetadata {
    return {
      ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
      description: skill.description,
      ...(skill.license ? { license: skill.license } : {}),
      ...(skill.metadata ? { metadata: skill.metadata } : {}),
      name: skill.name,
      path: skill.dirAbsPath,
      'user-invocable': skill.userInvocable,
    };
  }

  function toSkill(skill: ScannedSkill): Skill {
    const files = listings(skill);
    return {
      ...toMetadata(skill),
      assets: [...files.assets],
      instructions: skill.instructions,
      references: [...files.references],
      scripts: [...files.scripts],
      source: skill.sourceRootId
        ? { projectPath: skill.dirAbsPath, type: 'local' }
        : { mastraPath: skill.dirAbsPath, type: 'managed' },
    };
  }

  // Content paths are SKILL-ROOT-relative (e.g. "references/forms.md",
  // "scripts/run.sh") — the convention Mastra's own WorkspaceSkillsImpl uses
  // and its skill_read tool passes (it joins the tool-supplied path directly
  // onto skill.path). Containment-checked; never escapes the skill dir.
  function resolveContentPath(
    skillIdentifier: string,
    relPath: string
  ): { absFile: string; skill: ScannedSkill } | null {
    const skill = resolveSkill(skillIdentifier);
    if (!skill) {
      return null;
    }
    const segments = sanitizeRelativePath(relPath);
    if (!segments) {
      logger.warn('Refused skill content path (containment)', {
        path: relPath,
        skill: skill.name,
      });
      return null;
    }
    return { absFile: joinPath(skill.dirAbsPath, [...segments]), skill };
  }

  function readTextContent(skillIdentifier: string, relPath: string): string | null {
    const resolved = resolveContentPath(skillIdentifier, relPath);
    if (!resolved) {
      return null;
    }
    const read = deps.readFileText(resolved.absFile, MAX_SKILL_CONTENT_FILE_CHARS * 4);
    if (!read.ok) {
      if (read.reason === 'oversized') {
        logger.warn('Skill content file exceeds the read cap; not served', {
          cap: MAX_SKILL_CONTENT_FILE_CHARS,
          path: resolved.absFile,
        });
      }
      return null;
    }
    if (read.content.length > MAX_SKILL_CONTENT_FILE_CHARS) {
      logger.warn('Skill content file exceeds the read cap; not served', {
        cap: MAX_SKILL_CONTENT_FILE_CHARS,
        path: resolved.absFile,
      });
      return null;
    }
    return read.content;
  }

  function collectSkillMatches(
    skill: ScannedSkill,
    terms: readonly string[],
    includeReferences: boolean,
    results: SkillSearchResult[]
  ): void {
    appendLineMatches({ results, skill, source: 'SKILL.md', terms, text: skill.instructions });
    if (!includeReferences) {
      return;
    }
    for (const reference of listings(skill).references) {
      const content = readTextContent(skill.name, `references/${reference}`);
      if (content !== null) {
        appendLineMatches({
          results,
          skill,
          source: `references/${reference}`,
          terms,
          text: content,
        });
      }
    }
  }

  function searchTexts(
    query: string,
    options: SkillSearchOptions | undefined
  ): SkillSearchResult[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) {
      return [];
    }
    const includeReferences = options?.includeReferences !== false;
    const nameFilter = options?.skillNames ? new Set(options.skillNames) : null;
    const topK = Math.min(
      Math.max(Math.floor(options?.topK ?? DEFAULT_SEARCH_TOP_K), 1),
      MAX_SEARCH_TOP_K
    );
    const results: SkillSearchResult[] = [];

    for (const skill of enabledSkills()) {
      if (nameFilter && !nameFilter.has(skill.name)) {
        continue;
      }
      collectSkillMatches(skill, terms, includeReferences, results);
    }

    results.sort(
      (left, right) => right.score - left.score || left.skillName.localeCompare(right.skillName)
    );
    const minScore = options?.minScore;
    const filtered =
      minScore === undefined ? results : results.filter((result) => result.score >= minScore);
    return filtered.slice(0, topK);
  }

  return {
    async get(name: string): Promise<Skill | null> {
      const skill = resolveSkill(name);
      return skill ? toSkill(skill) : null;
    },
    async getAsset(skillName: string, assetPath: string): Promise<Buffer | null> {
      const resolved = resolveContentPath(skillName, assetPath);
      if (!resolved) {
        return null;
      }
      const read = deps.readFileBytes(resolved.absFile);
      if (!read.ok) {
        if (read.reason === 'oversized') {
          logger.warn('Skill asset exceeds the read cap; not served', {
            cap: MAX_SKILL_ASSET_BYTES,
            path: resolved.absFile,
          });
        }
        return null;
      }
      if (read.content.byteLength > MAX_SKILL_ASSET_BYTES) {
        logger.warn('Skill asset exceeds the read cap; not served', {
          cap: MAX_SKILL_ASSET_BYTES,
          path: resolved.absFile,
        });
        return null;
      }
      return Buffer.from(read.content);
    },
    async getReference(skillName: string, referencePath: string): Promise<string | null> {
      return readTextContent(skillName, referencePath);
    },
    async getScript(skillName: string, scriptPath: string): Promise<string | null> {
      return readTextContent(skillName, scriptPath);
    },
    async has(name: string): Promise<boolean> {
      return resolveSkill(name) !== null;
    },
    async list(): Promise<SkillMetadata[]> {
      return enabledSkills().map(toMetadata);
    },
    async listAssets(skillName: string): Promise<string[]> {
      const skill = resolveSkill(skillName);
      return skill ? [...listings(skill).assets] : [];
    },
    async listReferences(skillName: string): Promise<string[]> {
      const skill = resolveSkill(skillName);
      return skill ? [...listings(skill).references] : [];
    },
    async listScripts(skillName: string): Promise<string[]> {
      const skill = resolveSkill(skillName);
      return skill ? [...listings(skill).scripts] : [];
    },
    async maybeRefresh(): Promise<void> {
      ensureScanned();
    },
    async refresh(): Promise<void> {
      scanned = scan();
      listingsCache.clear();
    },
    async search(query: string, options?: SkillSearchOptions): Promise<SkillSearchResult[]> {
      return searchTexts(query, options);
    },
  };
}
