/**
 * Agent Skills contract (SKILL.md skills, https://agentskills.io).
 *
 * Shared between the desktop main process — which SCANS the four skills
 * location tiers off disk and serves the skills engine to the Mastra agent —
 * and the renderer, which lists skills in Settings, projects user-invocable
 * skills into the composer "/" menu, and persists enable/disable preferences.
 *
 * Everything here is serializable and browser-safe. The scanner, validation,
 * and the `WorkspaceSkills` engine live in `@brainstrike/agent` (they bind to
 * Mastra and to fs adapters); this module owns only the wire/UI shapes, the
 * durable preference-key derivation, and the `:skill[name]` activation
 * directive codec (the composer stages the directive text; the desktop
 * assistant server resolves it into an injected skill activation — mirroring
 * the `:file[...]` mention-directive split).
 */

/** Where a discovered skill came from, in scan priority order (highest first). */
export type SkillSourceTier =
  | 'root-brainstrike'
  | 'global-brainstrike'
  | 'root-claude'
  | 'global-claude';

/**
 * One discovered skill directory, as reported over the scan IPC to the
 * Settings panel and the composer slash-menu hook.
 *
 * - `ok`: a valid, active skill (spec warnings may still be present).
 * - `invalid`: SKILL.md exists but failed parsing/validation — surfaced with
 *   the exact errors so authors can fix it (fail closed, never silent).
 * - `shadowed`: valid, but a higher-priority tier (or earlier-mounted root)
 *   already claimed the name; `shadowedBy` names the winner.
 */
export interface SkillScanEntrySummary {
  /** Absolute path of the skill directory (display / reveal-in-folder). */
  readonly absPath: string;
  readonly description?: string;
  /** The skill directory's name (the spec requires `name` to match it). */
  readonly dirName: string;
  /** Validation/parse errors — present only for `status: 'invalid'`. */
  readonly errors?: readonly string[];
  /** Frontmatter `name` when it parsed (absent for unparseable files). */
  readonly name?: string;
  /** Durable enable/disable key — present for `ok` and `shadowed` entries. */
  readonly preferenceKey?: string;
  /** The winning skill this entry lost the name to (`status: 'shadowed'`). */
  readonly shadowedBy?: { readonly absPath: string; readonly tier: SkillSourceTier };
  /** Owning root's display name for project-scoped tiers (UI grouping). */
  readonly sourceRootDisplayName?: string;
  /** Owning DB `roots.id` for project-scoped tiers; absent for global tiers. */
  readonly sourceRootId?: string;
  readonly status: 'invalid' | 'ok' | 'shadowed';
  readonly tier: SkillSourceTier;
  /** Whether the skill may be invoked from the composer "/" menu (spec default true). */
  readonly userInvocable?: boolean;
  /** Non-fatal spec warnings (e.g. instructions over the recommended size). */
  readonly warnings?: readonly string[];
}

/** The skills scan IPC payload. */
export interface SkillsScanResultSummary {
  readonly entries: readonly SkillScanEntrySummary[];
}

/**
 * Renderer-supplied skills preference, attached to the assistant request as
 * `runtimeData.skillsPreference`. A PREFERENCE, not a security boundary — it
 * can only REDUCE the skill set (master off / per-skill disable), never inject
 * skills. Absent ⇒ master enabled, nothing disabled (fail-safe default).
 */
export interface SkillsContextRequest {
  /** Durable keys ({@link deriveSkillPreferenceKey}) of disabled skills. */
  readonly disabledSkillKeys: readonly string[];
  /** Master switch for the whole skills feature (default true). */
  readonly masterEnabled: boolean;
}

/**
 * Derive the durable enable/disable key for a skill: root-scoped skills key by
 * the DB `roots.id` (NEVER a raw path — adapter ids and paths churn across
 * remount), global skills key by name alone. The `.brainstrike` and `.claude`
 * tiers of the same scope deliberately SHARE a key: only one of them can be
 * active for a given name (first-tier-wins), so identity is (scope, name) —
 * a disable survives the winner flipping between the two dirs.
 */
export function deriveSkillPreferenceKey(input: {
  readonly name: string;
  readonly sourceRootId?: string;
}): string {
  return input.sourceRootId ? `root:${input.sourceRootId}:${input.name}` : `global:${input.name}`;
}

/**
 * Hard cap on distinct skill activations honored per user message. Directives
 * beyond the cap are reported in an honest omission note by the server-side
 * injector — never silently dropped.
 */
export const MAX_ACTIVATED_SKILLS_PER_MESSAGE = 8;

/** Spec name charset: 1–64 chars of lowercase letters, digits, and hyphens. */
const SKILL_DIRECTIVE_PATTERN = /:skill\[([a-z0-9-]{1,64})\]/g;

/**
 * Serialize a skill name into the composer activation directive. The composer
 * stages this text visibly (the user can edit or remove it before sending);
 * the desktop assistant server resolves it into an injected skill activation.
 */
export function serializeSkillDirective(name: string): string {
  return `:skill[${name}]`;
}

/**
 * Extract every well-formed `:skill[name]` directive from a message, deduped
 * in first-occurrence order. Malformed names (wrong charset, over-long, empty)
 * do NOT match — they stay inert text, mirroring the file-mention directive's
 * fail-inert posture. Enforcement of the per-message activation cap happens at
 * the server-side injector (with a visible omission note), not here.
 */
export function extractSkillDirectives(text: string): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SKILL_DIRECTIVE_PATTERN)) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
