/**
 * User-defined persona contract (shared between the desktop main process, which
 * SCANS `.md` persona files off disk, and the renderer settings panel, which
 * lists them). A persona file becomes an {@link AssistantPersonaDefinition}
 * with `source: 'user'` — the SAME shape the built-ins use, so the delegation
 * runtime (build-persona-subagents, delegation caps, run events) treats both
 * identically.
 *
 * Posture mirrors user-slash-commands.ts: hand-rolled frontmatter (NO YAML
 * dep), fail-closed on malformed input (a broken file is skipped with a
 * visible error, never half-parsed). Absent mode preserves read-only behavior;
 * explicit worker mode selects an eligible host scope without granting authority.
 */

import { NATIVE_TOOL_ID } from './native-tool-catalog.js';
import {
  type AssistantPersonaDefinition,
  type AssistantPersonaMode,
  type AssistantPersonaModelPin,
  assertPersonaToolScope,
  BUILT_IN_PERSONAS,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from './personas.js';
import { isSupportedProvider } from './provider-metadata.js';
import { SUBAGENT_SETTINGS_LIMITS } from './subagent-settings.js';
import { getNativeToolDefaults } from './tool-categories.js';

/** Directory (under `.brainstrike/`) scanned for persona `.md` files. */
export const USER_PERSONA_DIRNAME = 'agents';

/** Per-file char cap — persona files are untrusted repo content (same cap as commands). */
export const MAX_USER_PERSONA_FILE_CHARS = 64 * 1024;

/** Total persona count cap per scan; the rest are ignored with a visible warn. */
export const MAX_USER_PERSONAS = 50;

/**
 * Hard ceiling a user persona's maxSteps may declare: the host's
 * `maxChildSteps` ceiling, which is also what every built-in declares, so a
 * user persona can replicate any built-in. The user's `maxChildSteps` setting
 * governs the budget (`effectiveChildStepBudget`); a persona only LOWERS it.
 */
export const MAX_USER_PERSONA_MAX_STEPS = SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max;

/** maxSteps applied when the frontmatter omits it: no persona cap, the setting governs. */
export const DEFAULT_USER_PERSONA_MAX_STEPS = MAX_USER_PERSONA_MAX_STEPS;

/**
 * Toolset applied when the frontmatter omits `tools:` — the curated read-only
 * exploration set. Deliberately EXCLUDES `webSearch` (external egress must be
 * an explicit author choice) and the read-risk-but-interactive tools
 * (`askUser`, `submitPlan`), which require explicit declaration and durable
 * child control. `manageTaskList` belongs to the parent.
 *
 * `querySelf` is ALSO deliberately excluded, and this is not an oversight.
 * `assertReadOnlyPersona` would accept it (its risk category is `read`, earned
 * by a genuine sandbox), but a delegated child composing arbitrary SQL is a
 * materially wider surface than the curated exploration set. A
 * persona author must opt in explicitly via `tools:`. Pinned by
 * `user-personas.test.ts`.
 */
export const DEFAULT_USER_PERSONA_TOOL_IDS: readonly string[] = [
  NATIVE_TOOL_ID.queryEmbeddingSpace,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.findWorkspaceSymbol,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.readToolOutputArtifact,
];

const NATIVE_TOOL_ID_PREFIX = 'brainstrike.';

/** `agent-<id>` must satisfy provider tool-name charsets — no ':', spaces, or unicode. */
const PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Provider tool-name length cap (Anthropic/OpenAI: 64 chars). The delegation
 * tool is `agent-<id>`, so the id budget is 64 minus the prefix.
 */
const PROVIDER_TOOL_NAME_MAX_CHARS = 64;
export const MAX_USER_PERSONA_ID_LENGTH =
  PROVIDER_TOOL_NAME_MAX_CHARS - SUBAGENT_DELEGATION_TOOL_PREFIX.length;

/** Task-list state belongs to the parent; interactive tools are capability-gated at runtime. */
const USER_PERSONA_DISALLOWED_TOOL_IDS: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.manageTaskList,
]);

const MODEL_PIN_SEPARATOR = '::';

const FRONTMATTER_FENCE = '---';

/** Frontmatter keys that hold a list value (inline comma form or `- item` lines). */
const LIST_KEYS = new Set(['tools']);

export type ParsedUserPersonaFile =
  | {
      readonly description?: string;
      readonly instructions: string;
      readonly maxSteps?: number;
      readonly mode?: AssistantPersonaMode;
      readonly model?: string;
      readonly name?: string;
      readonly ok: true;
      readonly tools?: readonly string[];
    }
  | { readonly error: string; readonly ok: false };

interface FrontmatterAccumulator {
  description?: string;
  maxSteps?: number;
  mode?: AssistantPersonaMode;
  model?: string;
  name?: string;
  /**
   * The list key currently consuming `- item` continuation lines, if any.
   * Explicitly `| undefined` (not just optional): the key-value consumer
   * re-assigns `undefined` to CLOSE an open list, which
   * exactOptionalPropertyTypes forbids on a plain optional property.
   */
  openListKey: string | undefined;
  tools?: string[];
}

/** Consume a `- item` continuation line. Returns an error for a stray item. */
function consumeListItemLine(state: FrontmatterAccumulator, trimmed: string): string | null {
  // A list item is only legal under an open list key (`tools:`); a stray item
  // would silently vanish otherwise — fail closed instead.
  if (state.openListKey === undefined) {
    return `list item outside a list key: ${trimmed}`;
  }
  const item = trimmed.slice(1).trim();
  if (item.length > 0 && state.openListKey === 'tools') {
    state.tools = state.tools ?? [];
    state.tools.push(item);
  }
  return null;
}

/** Consume a `key: value` line. Returns an error string on malformed input. */
function consumeKeyValueLine(state: FrontmatterAccumulator, line: string): string | null {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex <= 0) {
    return `malformed frontmatter line: ${line}`;
  }
  const key = line.slice(0, separatorIndex).trim().toLowerCase();
  const value = line.slice(separatorIndex + 1).trim();
  state.openListKey = LIST_KEYS.has(key) && value.length === 0 ? key : undefined;

  switch (key) {
    case 'name': {
      state.name = value;
      return null;
    }
    case 'description': {
      state.description = value;
      return null;
    }
    case 'mode': {
      if (value !== 'worker' && value !== 'read-only') {
        return 'mode must be read-only or worker';
      }
      state.mode = value;
      return null;
    }
    case 'model': {
      state.model = value;
      return null;
    }
    case 'maxsteps': {
      if (!/^\d+$/.test(value)) {
        return `maxSteps must be a positive integer, got: ${value}`;
      }
      state.maxSteps = Number.parseInt(value, 10);
      return null;
    }
    case 'tools': {
      if (value.length > 0) {
        state.tools = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      } else {
        state.tools = state.tools ?? [];
      }
      return null;
    }
    default: {
      // Unknown scalar keys are ignored (forward compatibility).
      return null;
    }
  }
}

/** Consume one frontmatter line into the accumulator; error string on failure. */
function consumeFrontmatterLine(state: FrontmatterAccumulator, line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return null;
  }
  if (trimmed.startsWith('-')) {
    return consumeListItemLine(state, trimmed);
  }
  return consumeKeyValueLine(state, line);
}

/**
 * Parse a persona file. Unlike command files, a persona REQUIRES frontmatter
 * (`description` is mandatory downstream), so a file that does not open with a
 * `---` fence fails closed instead of becoming a whole-file template.
 */
export function parseUserPersonaFile(content: string): ParsedUserPersonaFile {
  // Strip a leading UTF-8 BOM so a BOM-prefixed `---` still opens frontmatter.
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_FENCE) {
    return {
      error: 'persona files require frontmatter: the file must open with a --- fence',
      ok: false,
    };
  }

  const closingIndex = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (closingIndex === -1) {
    return { error: 'unterminated frontmatter: no closing --- fence', ok: false };
  }

  const state: FrontmatterAccumulator = { openListKey: undefined };
  for (let index = 1; index < closingIndex; index += 1) {
    const error = consumeFrontmatterLine(state, lines[index] ?? '');
    if (error !== null) {
      return { error, ok: false };
    }
  }

  const instructions = lines
    .slice(closingIndex + 1)
    .join('\n')
    .replace(/^\n/, '');

  return {
    instructions,
    ok: true,
    ...(state.name ? { name: state.name } : {}),
    ...(state.description ? { description: state.description } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.mode ? { mode: state.mode } : {}),
    ...(state.maxSteps === undefined ? {} : { maxSteps: state.maxSteps }),
    ...(state.tools === undefined ? {} : { tools: state.tools }),
  };
}

export type DeriveUserPersonaIdResult =
  | { readonly id: string; readonly ok: true }
  | { readonly error: string; readonly ok: false };

/**
 * Derive the persona id from the file name (flat scan — no directory
 * namespacing: the id becomes the `agent-<id>` delegation tool name, and
 * provider tool-name charsets forbid ':').
 */
export function deriveUserPersonaId(fileName: string): DeriveUserPersonaIdResult {
  const id = fileName.replace(/\.(md|markdown|mdown|mkd)$/i, '');
  if (!PERSONA_ID_PATTERN.test(id)) {
    return {
      error:
        `invalid persona id '${id}': ids must start with a letter or digit and use only ` +
        'letters, digits, underscore, or hyphen (the id becomes the agent-<id> tool name)',
      ok: false,
    };
  }
  if (id.length > MAX_USER_PERSONA_ID_LENGTH) {
    return {
      error:
        `persona id '${id}' is too long (${id.length} chars): the agent-<id> tool name must ` +
        `fit the ${PROVIDER_TOOL_NAME_MAX_CHARS}-char provider tool-name limit, so ids are ` +
        `capped at ${MAX_USER_PERSONA_ID_LENGTH} chars`,
      ok: false,
    };
  }
  return { id, ok: true };
}

export type ParsePersonaModelPinResult =
  | { readonly ok: true; readonly pin: AssistantPersonaModelPin }
  | { readonly error: string; readonly ok: false };

/**
 * Parse a `provider::modelId` pin (the repo's established model-key format).
 * Exactly one format — no `provider/model` guessing (a `/` is legal inside
 * OpenRouter model ids).
 */
export function parsePersonaModelPin(value: string): ParsePersonaModelPinResult {
  const separatorIndex = value.indexOf(MODEL_PIN_SEPARATOR);
  if (separatorIndex === -1) {
    return {
      error: `invalid model pin '${value}': expected provider::modelId`,
      ok: false,
    };
  }
  const provider = value.slice(0, separatorIndex).trim();
  const modelId = value.slice(separatorIndex + MODEL_PIN_SEPARATOR.length).trim();
  if (provider.length === 0 || modelId.length === 0) {
    return {
      error: `invalid model pin '${value}': provider and modelId must both be non-empty`,
      ok: false,
    };
  }
  return { ok: true, pin: { modelId, provider } };
}

export interface AssistantPersonaAvailabilityIssue {
  readonly code:
    | 'credential-missing'
    | 'credential-unreadable'
    | 'model-not-listed'
    | 'model-unsupported'
    | 'worker-model-unsupported'
    | 'tool-not-discovered'
    | 'tool-disabled';
  readonly message: string;
  readonly toolId?: string;
}

/** Static host facts only; the selected model, capabilities and permissions are checked per run. */
export interface AssistantPersonaAvailability {
  readonly issues: readonly AssistantPersonaAvailabilityIssue[];
  readonly status: 'blocked' | 'needs-attention' | 'request-dependent';
}

/**
 * One persona row as the discovery IPC reports it to the settings panel:
 * built-ins and user personas in one list, INCLUDING invalid user files (with
 * their error) and files SHADOWED by a higher-priority tier, so authors see
 * exactly why a persona did not load.
 */
export interface AssistantPersonaListItem {
  /** Absolute file path (user personas only). */
  readonly absPath?: string;
  /**
   * Declared capability set for a loadable persona (status 'ok'): exact tool
   * ids, or the sole `'*'` meaning every tool the host permits. Taken from
   * the definition the host builds the child from (`personaScope`).
   */
  readonly allowedToolIds?: readonly string[];
  readonly availability?: AssistantPersonaAvailability;
  readonly description: string;
  /** Why the file failed to load (user personas with status 'invalid'). */
  readonly error?: string;
  readonly id: string;
  readonly label: string;
  /** Declared step budget (status 'ok'); Settings shows the host-capped value. */
  readonly maxSteps?: number;
  /** Effective mode (status 'ok'): a persona without an explicit mode is read-only. */
  readonly mode?: AssistantPersonaMode;
  /** Serialized `provider::modelId` pin, for display. */
  readonly modelPin?: string;
  /** The file that KEPT this id, for status 'shadowed'. Shaped like
   * skill-scan's `shadowedBy` so both features answer the author's actual
   * question — WHICH file won — rather than only naming a tier. */
  readonly shadowedBy?: { readonly absPath: string; readonly sourceRootId?: string };
  readonly source: 'built-in' | 'user';
  /** Owning root id for project-scoped user personas. */
  readonly sourceRootId?: string;
  /**
   * 'shadowed' is deliberately its OWN state rather than an error: a
   * suppressed duplicate is a precedence outcome, not an authoring mistake,
   * and reporting it as invalid would send the author hunting for a defect
   * that is not there. It shares 'invalid''s lack of a toggle, since neither
   * is a loadable persona (BST-936).
   */
  readonly status: 'invalid' | 'ok' | 'shadowed';
}

/** The persona discovery IPC payload. */
export interface AssistantPersonasListResult {
  /**
   * Directories that were NOT fully scanned, with why. Both causes make
   * personas silently absent, which is the failure this panel exists to
   * break: 'listing-truncated' = the directory had more entries than the
   * listing bound; 'cap-reached' = the scan cap was exhausted before this
   * directory was read at all (so a root full of malformed files can no
   * longer quietly starve `~/.brainstrike/agents`).
   */
  readonly incompleteDirs?: readonly {
    readonly dir: string;
    readonly reason: 'cap-reached' | 'listing-truncated';
  }[];
  readonly personas: readonly AssistantPersonaListItem[];
}

export interface BuildUserPersonaInput {
  readonly content: string;
  /** Base file name (e.g. `security-auditor.md`) — the id derives from it. */
  readonly fileName: string;
}

export type BuildUserPersonaResult =
  | { readonly ok: true; readonly persona: AssistantPersonaDefinition }
  | { readonly error: string; readonly ok: false };

const BUILT_IN_PERSONA_IDS = new Set<string>(BUILT_IN_PERSONAS.map((persona) => persona.id));

function normalizeToolId(toolId: string, mode: AssistantPersonaMode): string {
  if (toolId.includes('.')) {
    return toolId;
  }
  const nativeId = `${NATIVE_TOOL_ID_PREFIX}${toolId}`;
  // Native short names are normalized; a worker's opaque MCP id remains exact.
  return mode === 'read-only' || getNativeToolDefaults(nativeId) ? nativeId : toolId;
}

/**
 * Parse + validate a persona file into an {@link AssistantPersonaDefinition}.
 * Every failure mode returns a structured error (surfaced in the personas
 * settings panel next to the file), never a throw and never a silent fix-up:
 * out-of-range maxSteps is an ERROR (not a clamp), an unknown pin provider is
 * an ERROR (not a fallback to the parent model), a non-read tool is an ERROR.
 */
type PersonaFieldResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: string; readonly ok: false };

/**
 * The FULL persona-id gate: filename derivation PLUS the built-in collision
 * check. Exported because the desktop loader reserves ids before parsing, and
 * reserving through only the derivation half mislabels built-in collisions —
 * the second same-named file would be reported as "shadowed by another file"
 * when in truth NEITHER can load, because a built-in owns the name (BST-936).
 */
export function resolveUserPersonaId(fileName: string): PersonaFieldResult<string> {
  const derived = deriveUserPersonaId(fileName);
  if (!derived.ok) {
    return { error: derived.error, ok: false };
  }
  if (BUILT_IN_PERSONA_IDS.has(derived.id)) {
    return {
      error: `persona id '${derived.id}' collides with a built-in persona`,
      ok: false,
    };
  }
  return { ok: true, value: derived.id };
}

function resolvePersonaMaxSteps(declared: number | undefined): PersonaFieldResult<number> {
  const maxSteps = declared ?? DEFAULT_USER_PERSONA_MAX_STEPS;
  if (maxSteps < 1 || maxSteps > MAX_USER_PERSONA_MAX_STEPS) {
    return {
      error: `maxSteps must be between 1 and ${MAX_USER_PERSONA_MAX_STEPS}, got ${maxSteps}`,
      ok: false,
    };
  }
  return { ok: true, value: maxSteps };
}

function resolvePersonaModelPin(
  declared: string | undefined
): PersonaFieldResult<AssistantPersonaModelPin | undefined> {
  if (declared === undefined) {
    return { ok: true, value: undefined };
  }
  const pinResult = parsePersonaModelPin(declared);
  if (!pinResult.ok) {
    return { error: pinResult.error, ok: false };
  }
  if (!isSupportedProvider(pinResult.pin.provider)) {
    return {
      error: `unknown model pin provider '${pinResult.pin.provider}'`,
      ok: false,
    };
  }
  return { ok: true, value: pinResult.pin };
}

function resolvePersonaTools(
  declared: readonly string[] | undefined,
  mode: AssistantPersonaMode
): PersonaFieldResult<readonly string[]> {
  const allowedToolIds =
    declared === undefined
      ? mode === 'worker'
        ? ['*']
        : DEFAULT_USER_PERSONA_TOOL_IDS
      : declared.map((id) => normalizeToolId(id, mode));
  if (allowedToolIds.length === 0) {
    return { error: 'persona tools list must not be empty', ok: false };
  }
  const disallowed = allowedToolIds.find((toolId) => USER_PERSONA_DISALLOWED_TOOL_IDS.has(toolId));
  if (disallowed) {
    return {
      error: `tool '${disallowed}' is not available to subagent personas: task-list state belongs to the parent`,
      ok: false,
    };
  }
  return { ok: true, value: allowedToolIds };
}

export function buildUserPersona(input: BuildUserPersonaInput): BuildUserPersonaResult {
  if (input.content.length > MAX_USER_PERSONA_FILE_CHARS) {
    return {
      error: `persona file exceeds ${MAX_USER_PERSONA_FILE_CHARS} chars`,
      ok: false,
    };
  }

  const id = resolveUserPersonaId(input.fileName);
  if (!id.ok) {
    return { error: id.error, ok: false };
  }

  const parsed = parseUserPersonaFile(input.content);
  if (!parsed.ok) {
    return { error: parsed.error, ok: false };
  }
  if (!parsed.description || parsed.description.length === 0) {
    return { error: 'persona frontmatter requires a description', ok: false };
  }
  const instructions = parsed.instructions.trim();
  if (instructions.length === 0) {
    return { error: 'persona body (instructions) must not be empty', ok: false };
  }

  const maxSteps = resolvePersonaMaxSteps(parsed.maxSteps);
  if (!maxSteps.ok) {
    return { error: maxSteps.error, ok: false };
  }
  const model = resolvePersonaModelPin(parsed.model);
  if (!model.ok) {
    return { error: model.error, ok: false };
  }
  const tools = resolvePersonaTools(parsed.tools, parsed.mode ?? 'read-only');
  if (!tools.ok) {
    return { error: tools.error, ok: false };
  }

  const persona: AssistantPersonaDefinition = {
    allowedToolIds: tools.value,
    description: parsed.description,
    id: id.value,
    instructions,
    label: parsed.name && parsed.name.length > 0 ? parsed.name : id.value,
    maxSteps: maxSteps.value,
    source: 'user',
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    ...(model.value ? { model: model.value } : {}),
  };

  try {
    assertPersonaToolScope(persona);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'persona failed the read-only check',
      ok: false,
    };
  }

  return { ok: true, persona };
}
