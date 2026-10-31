/**
 * `defineNativeTool()` — the ONE definition per native tool (BST-1646).
 *
 * Every per-tool facet that used to live in its own hand-maintained
 * `Record<NativeToolId, …>` (catalog id, description, defaults, discovery
 * namespace, capability family, surfaces, history posture, non-durable output,
 * display prose, activity verb) is declared HERE, once, and `./index.ts` derives every
 * registry under its historical export name. Adding a tool is one definition
 * file plus one executor entry; a facet that is not declared cannot drift,
 * because nothing else lists tools.
 *
 * Browser-safe by construction: this module imports only schema types, the
 * risk resolver, and the schema wrappers. Execution stays in the desktop
 * executor map and Mastra.
 */
import { resolveToolRiskCategory } from '../tool-risk.ts';
import type { EffectToolInputSchema } from './schemas/effect-tool-input.ts';
import type { NativeToolDefaultMetadata } from './taxonomy.ts';

/** One Effect-authored boundary per native tool. */
type NativeToolInputSchema = EffectToolInputSchema<unknown>;

/** Where a desktop native tool is advertised and registered. */
export type NativeToolSurface =
  /** The Electron desktop assistant server (every desktop tool). */
  | 'desktop'
  /** The Hosted Web assistant (no local PGlite/PTY/browser-pane/worktree hosts). */
  | 'web';

/**
 * Provider-facing deferred groups. Each namespace stays below ten functions so
 * native provider search receives enough semantic detail without reintroducing
 * the complete tool-schema payload. Summaries live in `tool-discovery.ts`.
 */
export type NativeToolDiscoveryNamespace =
  | 'artifacts'
  | 'context'
  | 'database'
  | 'embeddings'
  | 'execution'
  | 'semantics'
  | 'sessions'
  | 'skills'
  | 'web'
  | 'workspace';

/**
 * The short model-facing capability phrases the discovery line and the
 * `search_tools` description name. ORDER matters (it is the order the phrases
 * are emitted in the prompt) and is owned by `DEFERRED_CAPABILITY_FAMILY_PHRASES`
 * in `./capability-families.ts`; a definition only picks one.
 */
export type DeferredCapabilityFamilyPhrase =
  | 'canvas documents'
  | 'task lists'
  | 'skill scripts'
  | 'Python'
  | 'browser pages'
  | 'web search/extract'
  | 'command sessions'
  | 'git worktrees'
  | 'file delete/rename'
  | 'directory listings'
  | 'workspace context'
  | 'symbol and LSP inspection'
  | 'embedding search'
  | 'diagnostics'
  | 'tool-output artifacts';

/**
 * Settled-history posture for the two projection processors. Both are
 * ALLOWLISTS: a tool that declares neither stays verbatim in provider history.
 * The two sets are deliberately NOT one flag — the filter's allowlist is
 * narrower by design (sessions, skills, and verification tools stay verbatim
 * there; see `projection-safe-tool-call-filter.ts`), while recency pruning
 * covers every genuinely read-only, cheap-to-re-run tool
 * (`tool-projection-prune.ts`). Declaring them side by side per tool is what
 * keeps that difference visible instead of drifting across two files.
 */
export interface NativeToolHistoryPosture {
  /**
   * Recency pruning may replace this settled, idempotent read's projection
   * with a "re-run the tool" marker once it falls outside the protected window.
   */
  readonly recencyPrunable?: true;
  /**
   * Stale settled calls may be replaced by a replay of the stored model-output
   * projection in a later user message.
   */
  readonly staleReplayable?: true;
}

/**
 * Resolves model-facing (sanitized, possibly hash-suffixed) tool names for a
 * definition's `instruction` hook. A name is `null` when the tool is not
 * registered for the run, so the hook can omit guidance for an absent verb.
 */
export interface NativeToolNameResolver {
  /** Model-facing name of another catalog tool by canonical id; throws for an id outside the catalog. */
  readonly of: (toolId: string) => string | null;
  /** Model-facing name of THIS tool (never null: the hook only runs when the tool is registered). */
  readonly self: string;
}

/**
 * How long one execution of this tool may run (BST-1777).
 *
 * Declared ONLY by tools whose input schema carries a model-settable
 * `timeoutMs`. It is the single source for two things that used to be
 * restated by hand and drifted: the executor's default/ceiling and the
 * per-tool execution guard's per-call budget. A tool that declares none is
 * bounded by the global guard default (`BRAINSTRIKE_TOOL_TIMEOUT_MS`).
 */
export interface NativeToolExecutionBudget {
  /** Budget when the call omits `timeoutMs`. */
  readonly defaultMs: number;
  /** Largest `timeoutMs` the input schema accepts. */
  readonly maxMs: number;
}

/**
 * Every icon/colour family a step in the activity trace can carry, in the
 * order the activity filter lists them. Native tools pick one in their
 * `activity`; the renderer adds the families of calls outside the catalog
 * (delegations, MCP calls, the host's meta tools, unknown names).
 */
export const VERB_FAMILIES = [
  'ask',
  'call',
  'canvas',
  'delegate',
  'edit',
  'memory',
  'other',
  'read',
  'run',
  'search',
  'skill',
  'tasks',
  'tools',
  'web',
  'worktree',
] as const;

export type VerbFamily = (typeof VERB_FAMILIES)[number];

/**
 * Whether the resting summary folds a verb's distinct targets into a file
 * count, and from which count. Set ONLY on verbs whose target IS a file —
 * never inferred from the family, since `read` also covers directory listings,
 * artifact reads and context reads ("Listed 2 files" was the defect).
 * `'always'` counts from one ("Edited 1 file": an edit names its file even
 * alone); `'plural'` counts only from two ("Read 2 files", but a single read
 * stays the bare "Read").
 */
export type ActivityFileCountMode = 'always' | 'plural';

/** How a call reads as a step in the activity trace. */
export interface NativeToolActivity {
  /** Present participle while the step runs: "Reading". */
  readonly active: string;
  /** Set only on file-targeted verbs; see `ActivityFileCountMode`. */
  readonly countsFiles?: ActivityFileCountMode;
  /** Past tense once it settled: "Read". */
  readonly done: string;
  /** Icon/colour family for the step row and summary grouping. */
  readonly family: VerbFamily;
  /**
   * The action as it was asked for, neither running nor done: "Run skill
   * script". A call that never ran (declined or blocked) and an approval,
   * which names the action it asks for, read this form.
   */
  readonly request: string;
  /**
   * The argument that names the step's target chip. Absent: the generic
   * reading (`extractPrimaryArg`'s priority keys, then the first string). A
   * key: that argument alone; several keys: the first present (a list of
   * names reads as one list). `null`: the arguments name no target at all —
   * they carry content (working memory's markdown, a canvas's HTML), which is
   * never a target.
   */
  readonly targetArg?: string | readonly string[] | null;
}

interface NativeToolDefinitionBase<Id extends string, In extends NativeToolInputSchema> {
  /** How a call of this tool reads in the activity trace. */
  readonly activity: NativeToolActivity;
  /** Load-ordering/UI taxonomy, prompt-budget estimate, approval flag, and explicit risk bucket. */
  readonly defaults: NativeToolDefaultMetadata;
  /** ONE prose source: the model-facing tool description AND the settings inspector text. */
  readonly description: string;
  /**
   * Deferred-tool discovery placement. REQUIRED for every non-critical tool
   * and FORBIDDEN for critical ones (critical tools are never behind
   * `search_tools`); `defineNativeTool` throws on either mismatch. `family`
   * names the capability phrase the discovery line advertises; skill tools
   * are force-cored by the runtime and carry no family.
   */
  readonly discovery?: {
    readonly family?: DeferredCapabilityFamilyPhrase;
    readonly namespace: NativeToolDiscoveryNamespace;
  };
  /**
   * Inspector-only prose per top-level input parameter, NEVER sent to the
   * model. Use it where a field's wire `.describe()` is absent or terser than
   * a human reader needs; prose the model should see belongs in `.describe()`.
   * `toToolSchemaDisplay` throws for a key that names no parameter.
   */
  readonly display?: Readonly<Record<string, string>>;
  /** Execution budget for tools with a model-settable `timeoutMs` (see the type). */
  readonly executionBudget?: NativeToolExecutionBudget;
  /** Settled-history posture for the two projection processors (see the type). */
  readonly history?: NativeToolHistoryPosture;
  readonly id: Id;
  /** ONE schema source: the exact registered input schema; the display schema derives from it. */
  readonly inputSchema: In;
  /**
   * Optional model-facing guidance composed into the default instructions
   * when the tool is registered for the run (see `default-instructions.ts`).
   * Keep it to one sentence: instructions sit inside the native-tool prompt
   * budget (`native-tool-prompt-budget.test.ts`).
   */
  readonly instruction?: (names: NativeToolNameResolver) => string;
  /** Results that must never be retained by durable artifact settlement. */
  readonly nonDurableOutput?: true;
  /** Inspector-only prose describing the result shape (not sent to the model). */
  readonly returns: string;
}

/**
 * A Brainstrike-owned tool: `brainstrike.*` id, executed by the desktop
 * executor map, registered with its Effect-authored schema.
 */
export interface DesktopNativeToolDefinition<
  Id extends `brainstrike.${string}` = `brainstrike.${string}`,
  In extends NativeToolInputSchema = NativeToolInputSchema,
> extends NativeToolDefinitionBase<Id, In> {
  readonly kind: 'desktop';
  /** Every surface that registers the tool; `desktop` is implied and listed for symmetry. */
  readonly surfaces: readonly NativeToolSurface[];
}

/** Mastra's canonical Agent Skills tool ids (deliberately NOT `brainstrike.*`-namespaced). */
type SkillNativeToolIdLiteral = 'skill' | 'skill_read' | 'skill_search';

/**
 * A Mastra-owned Agent Skills tool. Brainstrike does not execute it, but it
 * DOES impose the provider contract (`skill-tools.ts` overrides Mastra's
 * description and input schema with `providerDescription` and `inputSchema`
 * from here), so the wire schema and the inspector display share one source.
 */
export interface SkillNativeToolDefinition<
  Id extends SkillNativeToolIdLiteral = SkillNativeToolIdLiteral,
  In extends NativeToolInputSchema = NativeToolInputSchema,
> extends NativeToolDefinitionBase<Id, In> {
  readonly kind: 'skill';
  /** The compact description sent on the wire (the catalog `description` is the fuller UI text). */
  readonly providerDescription: string;
}

export type NativeToolDefinition = DesktopNativeToolDefinition | SkillNativeToolDefinition;

/** Thrown when a definition violates a structural invariant the registries rely on. */
export class InvalidNativeToolDefinitionError extends Error {
  readonly toolId: string;

  constructor(toolId: string, detail: string) {
    super(`Invalid native tool definition for ${toolId}: ${detail}`);
    this.name = 'InvalidNativeToolDefinitionError';
    this.toolId = toolId;
  }
}

function assertActivityForms(definition: NativeToolDefinition): void {
  const { active, done, request } = definition.activity;
  if (active === '' || done === '' || request === '' || active === done || request === active) {
    throw new InvalidNativeToolDefinitionError(
      definition.id,
      'activity needs distinct, non-empty active, done and request forms'
    );
  }
}

function assertExecutionBudget(definition: NativeToolDefinition): void {
  const budget = definition.executionBudget;
  if (budget === undefined) {
    return;
  }
  for (const [name, value] of [
    ['defaultMs', budget.defaultMs],
    ['maxMs', budget.maxMs],
  ] as const) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new InvalidNativeToolDefinitionError(
        definition.id,
        `executionBudget.${name} must be a positive integer (ms), received ${String(value)}`
      );
    }
  }
  if (budget.defaultMs > budget.maxMs) {
    throw new InvalidNativeToolDefinitionError(
      definition.id,
      `executionBudget.defaultMs (${budget.defaultMs}) exceeds maxMs (${budget.maxMs})`
    );
  }
}

/**
 * Declare one native tool. Returns the definition unchanged (literal types
 * preserved via the `const` type parameter) after the fail-loud checks:
 *
 * - an undeterminable risk category throws {@link UndeterminableToolRiskError}
 *   (`tool-risk.ts`) — a potentially dangerous tool is never silently bucketed;
 * - a deferred tool without a discovery namespace, or a critical tool with
 *   one, throws {@link InvalidNativeToolDefinitionError};
 * - a desktop tool must list the `desktop` surface;
 * - a deferred desktop tool must declare a `discovery.family` (otherwise it is
 *   behind `search_tools` with no advertised capability).
 * - a declared executionBudget must be two positive integers with defaultMs <= maxMs.
 * - the activity's active, done and request forms must be non-empty and distinct
 *   (active vs done, request vs active), so a step reads as running, settled or asked.
 */
export function defineNativeTool<const Definition extends NativeToolDefinition>(
  definition: Definition
): Definition {
  resolveToolRiskCategory(definition.defaults);
  assertExecutionBudget(definition);
  assertActivityForms(definition);
  if (definition.defaults.loadingTier === 'critical') {
    if (definition.discovery !== undefined) {
      throw new InvalidNativeToolDefinitionError(
        definition.id,
        'a critical tool is never behind search_tools, so it must not declare a discovery namespace'
      );
    }
  } else if (definition.discovery === undefined) {
    throw new InvalidNativeToolDefinitionError(
      definition.id,
      `a ${definition.defaults.loadingTier} tool must declare the discovery namespace it is searchable in`
    );
  }
  if (definition.kind === 'desktop') {
    if (!definition.id.startsWith('brainstrike.')) {
      throw new InvalidNativeToolDefinitionError(definition.id, 'desktop ids are brainstrike.*');
    }
    if (!definition.surfaces.includes('desktop')) {
      throw new InvalidNativeToolDefinitionError(
        definition.id,
        'every desktop tool registers on the desktop surface'
      );
    }
    if (definition.discovery !== undefined && definition.discovery.family === undefined) {
      // deriveCapabilityFamilies() advertises only definitions with a family;
      // a deferred desktop tool without one would be behind search_tools with
      // no capability line — reachable in principle, undiscoverable in practice.
      throw new InvalidNativeToolDefinitionError(
        definition.id,
        'a deferred desktop tool must declare the discovery.family its capability is advertised under'
      );
    }
  }
  return definition;
}
