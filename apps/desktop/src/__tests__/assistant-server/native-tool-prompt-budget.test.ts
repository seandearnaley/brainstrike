import {
  createAssistantSkillTools,
  createMastraAgentRuntime,
  createScannedWorkspaceSkills,
  NATIVE_TOOL_DEFAULTS,
  PROVIDER_DEFAULT_MODELS,
  type RuntimeData,
  type ScannedSkill,
  type ScannedWorkspaceSkills,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { getAdjustedTimeout } from '@brainstrike/test-utils';
import { get_encoding } from 'tiktoken';
import { describe, expect, it, vi } from 'vitest';
import { desktopHostToolExecutors } from '../../agent-host-platform/host-executed-tools';
import { runSkillScriptExecutor } from '../../assistant-server/native-tool-executors-skills';
import {
  buildHostNativeTools,
  nativeRuntimeFor,
  unexpectedMainRequest,
} from './_host-native-tools';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

// Raised 8250 → 8300 when querySelf gained its required `mode` discriminator.
// That was a CORRECTNESS fix, not a nicety: with optional mutually-exclusive
// fields the tool failed 100% of real calls, because providers using strict
// function calling force the model to emit every declared property. The prose
// was trimmed twice first (8300 → 8266 → 8258); what remains — the mode
// instruction, the verified example, and the pg_stat flush warning — all
// changes model behaviour, so it was not cut further.
//
// Raised 7900 → 8250 for `brainstrike.querySelf` (BST-913). The prior ceiling
// had ONE token of headroom (the surface measured 7899), so it correctly forced
// this to be a deliberate decision rather than a silent accretion.
//
// What was done before raising it: querySelf was trimmed from 435 to 305 tokens
// by cutting its description to a single worked example (the `describe` mode
// means the model discovers the schema itself rather than reading it here) and
// shortening the parameter prose. The remainder is the genuine cost of a new
// capability.
//
// Raised 8300 → 8350 for the hybrid one-statement idioms (BST-935). The 43
// added tokens (8299 → 8342 authored; +44 on the eager surface, which is a
// different concatenation and legitimately differs by one) are the two
// search-arm operator forms — content <@>
// to_bm25query('terms','idx_file_chunks_content_bm25') and embedding <=> a
// stored embedding — which are NOT discoverable through describeTable (an
// operator and an index name appear in no column listing), so a model asked to
// compose traversal+search cannot derive them and the capability is silently
// unreachable without this line. Trimming was considered first, per the rule
// below: the remaining querySelf prose is the set that survived two prior trim
// passes, each item behavior-changing, so the raise is the honest price.
//
// Raised 8350 → 8460 for lenses (BST-921). The 105 added tokens (8342 → 8447
// authored; +105 eager) are two new querySelf modes (listLenses, lens) plus
// the `lens` and `values` fields — a NEW capability (named parameterized
// retrieval artifacts under .brainstrike/lenses/*.sql, executed with real
// binds in the same sandbox), not prose growth on an existing one. Trimmed
// first per the rule below: the values-field describe and the description
// sentence were both cut to the bone (−16) before raising.
//
// `brainstrike.queryDiagnostics` (BST-853) costs 351 authored tokens for one
// required row/group mode plus seven optional exact/bounded filters. Replacing
// Zod's two generated leap-year date-time regexes with bounded strings plus
// explicit runtime validation recovered 345 tokens, so this capability fits
// well below the originally proposed 9155 ceiling. The tool remains deferred,
// leaving the 2157-token critical initial surface unchanged.
//
// BST-927 RESOLUTION — an explicit headroom BAND replaces the hair-trigger
// ceiling. The surface measured 8797 when the band was set; the ceiling gives
// ~150 tokens of headroom so an unrelated one-word description edit no longer
// fails the required Unit check, while genuine bloat still trips it. The NEW
// floor catches the other direction: a suspicious DROP (a tool or schema
// silently falling out of the registry) fails just as loudly as growth.
// The trim-first practice is unchanged: when the ceiling fires, trim before
// raising, and record the trade here as every prior raise did. For THIS
// authored pair, move both bounds together — the ~300 width is the contract,
// not the numbers. (The initial-core pair below has its own, wider band:
// its ceiling is a hard cap from the retired 11,500 boundary, not a
// measurement envelope.)
// BST-1067 RAISE (+170/+170, band width 300 preserved). `run_python` is a NEW
// capability — sandboxed Python execution — so its cost is genuine growth, not
// bloat. Trim-first was applied before raising: the first description spent
// 8982 authored tokens (32 over the old 8950 ceiling) and was cut to the
// security facts a model must know (no network, scratch-only writes,
// unrestricted reads, print() to return), landing at 8967. The new ceiling
// keeps the same ~150 tokens of headroom above that measurement the BST-927
// band was set with, and the floor moves with it so a silent DROP still fails.
// BST-1173 RAISE (+310/+310, band width 300 preserved). `manageCanvas` is a NEW
// persisted/versioned document capability: its six-field action surface costs
// 210 authored definition tokens, plus conditional hosted guidance and normal
// registry serialization, moving the measured full surface 8967 → 9278.
// Trim-first was applied: the raw top-level discriminated union both violated
// the provider root-object contract and measured 8727 eager-definition tokens;
// a strict root object delegating conditional validation to that union cut the
// eager aggregate to 8593 while retaining exact create/update/rewrite/list
// validation. The description and field prose now contain only the verb,
// required-field, exact-match, and versioning facts the model needs.
// BST-1176 RAISE (+380/+380, band width 300 preserved). Three NEW browser-pane
// tools — browserNavigate / browserReadPage / browserGetPageText — make the
// embedded pane agent-drivable (navigate, a11y-tree seeing, page text), moving
// the measured full surface 9278 → 9662. Genuine new capability, not bloat.
// Trim-first was applied: the bare-host/search normalization prose is stated
// ONCE in the navigate tool description (the url field describe was cut to
// three words), field describes are single-clause, and the a11y ref MAP is
// never serialized to the model (only the [ref=eN] handles inside the tree
// text). Ceiling keeps ~150 headroom above the measurement; the floor moves
// with it so a silent drop still fails.
// CURRENT-DATE RAISE (+40/+40, band width 300 preserved). The composed
// instructions now state today's date on EVERY provider path. Not bloat:
// nothing in the prompt said what day it was, so the model substituted its own
// guess — an observed run reasoned "Today's date is unknown but likely later"
// and wrote a fabricated date into DURABLE working memory. It is also
// load-bearing for an instruction AGENTS.md already gives (treat dated docs
// under docs/superpowers/ and docs/archive/ as historical), unfollowable
// without a date to compare against. Measured full surface 9807 -> 9841.
// Trim-first was applied: the first wording ran 49 tokens and was cut to 34.
//
// RAISED BY THE COST OF THIS CHANGE ONLY, deliberately (review of #2610). The
// previous ceiling of 9810 sat 3 tokens above a 9807 measurement, so ~145
// tokens had accumulated since the BST-1176 raise (9662, ~148 headroom) with no
// recorded trade. Absorbing that drift into this entry would launder it into
// the date's ledger and hide it for good. The tight headroom that remains is
// the honest signal: the next change here should account for the drift rather
// than paper over it again.
// SEARCH-TOOLS BATCHING EXEMPTION RAISE (+20/+20, band width 300 preserved).
// The batching line now exempts `search_tools`, whose matches only load on the
// NEXT turn. Not bloat: "Batch independent reads, searches, or commands into
// one turn" is a plausible proximate cause of an observed 15-minute waste, in
// which a model batched `search_tools` with two long delegations and stranded
// the discovery for their whole duration. Measured full surface 9841 -> 9859.
// Trim-first was applied: the clause was stated on BOTH the discovery line and
// the batching line, and the discovery line was reverted to its original
// wording — one statement, on the line that causes the misread.
// DEFERRED-CAPABILITY COVERAGE RAISE (+60/+60, band width 300 preserved). The
// discovery line now names EVERY deferred capability family, pinned by the
// 'tool-discovery capability coverage' spec. Not bloat: a family the prompt
// never names is a tool the model declares nonexistent instead of searching
// for — the 2026-08-23 field failure dismissed both "the canvas tool" and a
// skill's named run_skill_script as missing. The skill guidance also gained
// its search_tools recovery clause (tool OUTPUT, not counted here). Measured
// full surface 9859 -> 9912. Trim-first was applied: the line names families,
// not the 26 tool ids, and the "named but not loaded" sentence is stated once.
// BST-1392 RAISE (+316/+316, band width 300 preserved).
// `listWorktrees` and `manageWorktree` are a NEW isolated-checkout capability
// for the agent: the one-field listing costs 113 authored definition tokens
// and the seven-field management envelope 278, moving the measured full
// hosted surface 9912 → 10246.
//
// TRIM CONSIDERED AND REJECTED — no existing definition is paying for
// something this capability makes redundant, so this is a RAISE, not a
// rebalance, and the trade is stated rather than hidden:
//   * `brainstrike.executeCommand` cannot be trimmed: it is critical-tier and
//     the correlator in W5 Layer 4 depends on it running unchanged.
//   * No other tool overlaps worktree management; the nearest neighbour,
//     `manageCanvas`, addresses a different store entirely.
//   * The trim that WAS taken is structural: spec §6.4 named three tools
//     (createWorktree/listWorktrees/archiveWorktree) and this ships two, with
//     the mutations sharing one action envelope — roughly one tool definition
//     saved against the literal reading of the spec.
// If the raise pushes the aggregate band, do NOT widen the band: re-open the
// two-vs-three decision, or defer `manageWorktree` to a follow-up and ship the
// read-only listing first.
//
// HEADROOM RESTORATION (review round, same day): the raise above landed the
// measured surface EXACTLY at the new MAX (10246/10246) — zero headroom, the
// hair-trigger failure mode BST-927's band doctrine exists to prevent (any
// one-word description edit would fail this suite at this line). A first
// attempt at this fix moved both bounds by only +18 (10246 → 10264), leaving
// the measurement at 94% of the band — the SAME hair trigger under a new
// name. Re-reviewed and corrected to match the BST-1176 precedent (~150
// headroom): both bounds move +150 from the ORIGINAL post-raise values
// (10246 → 10396, 9946 → 10096), width 300 unchanged, putting the unchanged
// 10246 measurement at the band's MIDPOINT.
//
// BST-1995 removed `brainstrike.querySelf` and its lenses, a deliberate drop
// rather than a tool silently falling out: the authored surface measured 9825.
// Both bounds move down to centre that measurement (10,396 → 9,975 and
// 10,096 → 9,675), width 300 unchanged.
const MAX_AUTHORED_NATIVE_TOOL_TOKENS = 9975;
const MIN_AUTHORED_NATIVE_TOOL_TOKENS = 9675;
// BST-1667 TRIM (ceiling UNCHANGED at 5000 — the number is a live contract in
// docs/agents/assistant-providers.md, assistant-runtime.md, and
// workspace-context.md). Tool discovery moved to Mastra's manual loading, so
// the composed discovery line now teaches TWO controls — `load_tool` for an
// exact name and `search_tools` for a capability query — and first measured
// 5024. Trim-first was applied to that line only: articles and hedges
// dropped, "call search_tools with a concise query, then load_tool for the
// match" tightened, the miss exit shortened to "check the catalog for an
// exact name first" (its 'If the search finds nothing' pin kept), and the
// same-response parenthetical kept its pinned 'not a later user message'.
// Measured 4997 (see #3049 review): 3 tokens of headroom. The next addition
// to the discovery line must trim before it lands; a raise here needs the
// three contracts moved in the same change.
const MAX_MASTRA_OPENROUTER_INITIAL_CORE_TOKENS = 5000;
// Floor for the critical initial surface (measured 2157 per the
// queryDiagnostics note above): a silent drop of a critical-tier tool fails
// as loudly as bloat (BST-927 band doctrine).
const MIN_MASTRA_OPENROUTER_INITIAL_CORE_TOKENS = 2000;
const OPENROUTER_PROMPT_BUDGET_MODEL = 'openai/gpt-5.6-terra';
// runPython joined the suspending set in BST-1070 Gate B: without workflow
// storage its suspend metadata is stripped here for the same reason as the
// other two (this fixture measures the PROMPT surface, not resumability).
const SUSPENDING_TOOL_IDS = [
  'brainstrike.askUser',
  'brainstrike.runPython',
  'brainstrike.submitPlan',
] as const;
const PROMPT_BUDGET_SKILL = {
  containmentRoot: '/workspace',
  description: 'A minimal production-equivalent skill for prompt-budget coverage.',
  dirAbsPath: '/workspace/.brainstrike/skills/prompt-budget',
  dirName: 'prompt-budget',
  instructions: 'Use this skill to keep prompt-budget coverage production-equivalent.',
  name: 'prompt-budget',
  preferenceKey: 'root-a:root-brainstrike:prompt-budget',
  sourceRootDisplayName: 'Workspace',
  sourceRootId: 'root-a',
  tier: 'root-brainstrike',
  userInvocable: true,
  warnings: [],
} satisfies ScannedSkill;
const SKILLS_PROCESSOR_USAGE_INSTRUCTION =
  'IMPORTANT: Skills are NOT tools. Do not call skill names directly as tool names. To use a skill, call the `skill` tool with the skill name as the "name" parameter. If multiple skills share the same name, use the skill path (shown in the location field) instead of the name to disambiguate. When a user asks about a topic covered by an available skill, activate it immediately without asking for permission first.';

interface ProviderFunctionTool {
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
  type: 'function';
}

interface MastraProviderTool {
  description: string;
  inputSchema: unknown;
}

function createPromptBudgetWorkspaceSkills(): ScannedWorkspaceSkills {
  return createScannedWorkspaceSkills({
    deps: {
      listDir: () => null,
      readFileBytes: () => ({ ok: false, reason: 'unreadable' }),
      readFileText: () => ({ ok: false, reason: 'unreadable' }),
    },
    scan: () => ({
      entries: [{ skill: PROMPT_BUDGET_SKILL, status: 'ok' }],
      skills: [PROMPT_BUDGET_SKILL],
    }),
  });
}

/**
 * The launching desktop's facts: they give the host its run_python and
 * runSkillScript interpreter. Building the tools never reads them.
 */
const PROMPT_BUDGET_APP_PATHS = {
  isPackaged: false,
  resourcesPath: '/prompt-budget/resources',
  userDataPath: '/prompt-budget/user-data',
} as const;

function unusedPythonExecutable(): Promise<string> {
  return Promise.reject(new Error('The prompt-budget suite never runs a skill script'));
}

/** The host's own Tavily key owner; the suite never calls the web tools. */
const PROMPT_BUDGET_TAVILY = {
  resolveApiKey: () => Promise.resolve(undefined),
};

/**
 * The agent host's live tool fold, every capability present: Desktop's host
 * executors with the launching app's paths (run_python), plus runSkillScript
 * over the run's skills, as the host binds it beside the skill tools the
 * suite adds from `createAssistantSkillTools` (the host's `skillToolExecutors`
 * source). Core supplies the thread's artifact reader to every call, and the
 * host passes its own Tavily key owner to the web tools.
 */
function buildPromptBudgetDesktopTools(
  skillScriptResolver: ScannedWorkspaceSkills
): NonNullable<RuntimeData['mastraTools']> {
  const runtimeData = { provider: 'openrouter' } as RuntimeData;
  return buildHostNativeTools(runtimeData, {
    executors: {
      ...desktopHostToolExecutors(
        unexpectedMainRequest,
        'prompt-budget-thread',
        nativeRuntimeFor(runtimeData),
        PROMPT_BUDGET_APP_PATHS
      ),
      [NATIVE_TOOL_ID.runSkillScript]: runSkillScriptExecutor(
        skillScriptResolver,
        unusedPythonExecutable
      ),
    },
    ports: {
      artifactReader: {
        readRange: async () => ({ status: 'not_found' }),
      },
    },
    webExtract: PROMPT_BUDGET_TAVILY,
    webSearch: PROMPT_BUDGET_TAVILY,
  });
}

/**
 * Pins the first-turn system context emitted by Mastra 1.51's SkillsProcessor
 * for the representative skill above. createMastraAgentRuntime counts its
 * static skills guidance in getInstructions(), while this per-call processor
 * context is added later by buildToolLoopOptions and must be counted separately.
 * Keep this literal byte-aligned with @mastra/core when upgrading Mastra.
 */
function withSkillsProcessorContext(instructions: string): string {
  const availableSkill = `<available_skills>
  <skill>
    <name>${PROMPT_BUDGET_SKILL.name}</name>
    <description>${PROMPT_BUDGET_SKILL.description}</description>
    <location>${PROMPT_BUDGET_SKILL.dirAbsPath}/SKILL.md</location>
    <source>local</source>
  </skill>
</available_skills>`;
  return [instructions, availableSkill, SKILLS_PROCESSOR_USAGE_INSTRUCTION].join('\n');
}

function snapshotProviderToolSurface(
  tools: NonNullable<RuntimeData['mastraTools']>
): Readonly<Record<string, MastraProviderTool>> {
  return Object.fromEntries(
    Object.entries(tools).map(([toolId, tool]) => {
      const providerTool = tool as unknown as {
        description?: unknown;
        inputSchema?: unknown;
      };
      if (typeof providerTool.description !== 'string' || !('inputSchema' in providerTool)) {
        throw new Error(`Desktop tool ${toolId} is missing provider metadata`);
      }
      return [
        toolId,
        {
          description: providerTool.description,
          inputSchema: providerTool.inputSchema,
        },
      ];
    })
  );
}

/**
 * Suspension/resume schemas are workflow metadata, not model-visible tool
 * definitions. Strip only that metadata so the real Mastra conversion keeps
 * both hosted tools without constructing a database-backed workflow store.
 */
function omitNonProviderSuspendMetadata(
  tools: NonNullable<RuntimeData['mastraTools']>
): NonNullable<RuntimeData['mastraTools']> {
  const promptTools = { ...tools };
  for (const toolId of SUSPENDING_TOOL_IDS) {
    const tool = tools[toolId];
    if (!tool) {
      throw new Error(`Desktop hosted registry is missing ${toolId}`);
    }
    const providerTool = tool as unknown as {
      description?: unknown;
      execute?: unknown;
      id?: unknown;
      inputSchema?: unknown;
    };
    promptTools[toolId] = {
      description: providerTool.description,
      execute: providerTool.execute,
      id: providerTool.id,
      inputSchema: providerTool.inputSchema,
    } as unknown as typeof tool;
  }
  return promptTools;
}

interface JsonSchemaConversionContext {
  jsonSchema: Record<string, unknown>;
  zodSchema: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function applyMastraJsonSchemaOverride(context: JsonSchemaConversionContext): undefined {
  const zodSchema = asRecord(context.zodSchema);
  const jsonSchema = context.jsonSchema;
  if (
    jsonSchema['type'] === 'object' &&
    jsonSchema['properties'] !== undefined &&
    !jsonSchema['additionalProperties']
  ) {
    jsonSchema['additionalProperties'] = false;
  }

  const legacyDefinition = asRecord(zodSchema?.['_def']);
  const schemaType = zodSchema?.['type'];
  const isDate = schemaType === 'date' || legacyDefinition?.['typeName'] === 'ZodDate';
  if (isDate) {
    if (schemaType === 'date') {
      jsonSchema['type'] = 'string';
      jsonSchema['format'] = 'date-time';
    }
    const zodInternals = asRecord(zodSchema?.['_zod']);
    const zodDefinition = asRecord(zodInternals?.['def']);
    jsonSchema['x-date'] = !zodDefinition?.['coerce'];
    return;
  }

  const zodInternals = asRecord(zodSchema?.['_zod']);
  const zodDefinition = asRecord(zodInternals?.['def']);
  const catchall = asRecord(zodDefinition?.['catchall']);
  if (schemaType === 'object' && catchall?.['type'] === 'unknown') {
    jsonSchema['additionalProperties'] = true;
  }
}

/**
 * Mirrors @mastra/core 1.51's public standardSchemaToJSONSchema(..., { io:
 * 'input' }) boundary through the schema's Standard Schema protocol. Desktop
 * declares Zod, not @mastra/core, so the test invokes that protocol directly
 * instead of reaching through another workspace package's node_modules.
 */
function toMastraStandardInputJsonSchema(schema: unknown, toolName: string): unknown {
  const standard = asRecord(schema)?.['~standard'];
  const jsonSchema = asRecord(standard)?.['jsonSchema'];
  const input = asRecord(jsonSchema)?.['input'];
  if (typeof input !== 'function') {
    throw new Error(`Desktop tool ${toolName} is not a Standard Schema with JSON input support`);
  }
  const converted = input({
    libraryOptions: {
      override: applyMastraJsonSchemaOverride,
      unrepresentable: 'any',
    },
    target: 'draft-07',
  });
  return JSON.parse(JSON.stringify(converted)) as unknown;
}

function buildProviderFunctionTools(
  tools: Readonly<Record<string, MastraProviderTool>>,
  nameMap: ReadonlyMap<string, string>
): ProviderFunctionTool[] {
  return Array.from(nameMap, ([name, originalName]) => {
    const tool = tools[originalName];
    if (!tool) {
      throw new Error(`Runtime tool-name map references missing desktop tool ${originalName}`);
    }
    return {
      function: {
        description: tool.description,
        name,
        parameters: toMastraStandardInputJsonSchema(tool.inputSchema, originalName),
      },
      type: 'function' as const,
    };
  });
}

function buildAuthoredProviderFunctionTools(
  tools: NonNullable<RuntimeData['mastraTools']>
): ProviderFunctionTool[] {
  const providerTools = snapshotProviderToolSurface(tools);
  const nameMap = new Map(
    Object.keys(providerTools).map((toolId) => [toolId.replace(/[^a-zA-Z0-9_-]/g, '_'), toolId])
  );
  return buildProviderFunctionTools(providerTools, nameMap);
}

function countO200kTokens(text: string): number {
  const encoding = get_encoding('o200k_base');
  try {
    return encoding.encode(text).length;
  } finally {
    encoding.free();
  }
}

function formatBudgetFailure(args: {
  budget: number;
  descriptions: number;
  instructions: number;
  label: string;
  schemas: number;
  toolBreakdown: readonly { name: string; tokens: number }[];
  total: number;
}): string {
  const tools = args.toolBreakdown.map(({ name, tokens }) => `  ${name}: ${tokens}`).join('\n');
  return [
    `${args.label} is ${args.total} tokens; budget is ${args.budget}.`,
    `  instructions: ${args.instructions}`,
    `  descriptions: ${args.descriptions}`,
    `  schemas: ${args.schemas}`,
    '  serialized tools:',
    tools,
  ].join('\n');
}

function expectProviderSurfaceWithinBudget(args: {
  budget: number;
  floor: number;
  instructions: string;
  label: string;
  tools: readonly ProviderFunctionTool[];
}): void {
  for (const tool of args.tools) {
    expect(
      asRecord(tool.function.parameters)?.['type'],
      `${tool.function.name} must expose a provider-compatible root object schema`
    ).toBe('object');
  }
  const payload = JSON.stringify({ instructions: args.instructions, tools: args.tools });
  const total = countO200kTokens(payload);
  const toolBreakdown = args.tools.map((tool) => ({
    name: tool.function.name,
    tokens: countO200kTokens(JSON.stringify(tool)),
  }));
  const descriptions = countO200kTokens(
    args.tools.map((tool) => tool.function.description).join('\n')
  );
  const schemas = args.tools.reduce(
    (tokens, tool) => tokens + countO200kTokens(JSON.stringify(tool.function.parameters)),
    0
  );
  const instructions = countO200kTokens(args.instructions);

  expect(
    total,
    formatBudgetFailure({
      budget: args.budget,
      descriptions,
      instructions,
      label: args.label,
      schemas,
      toolBreakdown,
      total,
    })
  ).toBeLessThanOrEqual(args.budget);
  expect(
    total,
    formatBudgetFailure({
      budget: args.floor,
      descriptions,
      instructions,
      label: `${args.label} BELOW FLOOR — a tool or schema likely fell out of the registry silently (BST-927 band)`,
      schemas,
      toolBreakdown,
      total,
    })
  ).toBeGreaterThanOrEqual(args.floor);
}

// This suite loads the o200k tokenizer and constructs the full desktop native
// tool registry. It is computationally heavy, not a UI-component test, and its
// measured wall time is contention-sensitive (BST-1050). The 30s heavy base is
// honest for isolated iteration (measured p50 ~10.5s); official root batteries
// apply the explicit 2x policy. A direct package/editor run under deliberate
// host contention should set TEST_TIMEOUT_MULTIPLIER=2: a historical loaded
// tail reached ~33s, which does not justify silently moving the base to the 120s
// performance band.
vi.setConfig({ testTimeout: getAdjustedTimeout('heavy') });

describe('desktop native tool provider prompt budget', () => {
  it('records the eager baseline and proposed critical-only definition footprint', () => {
    const workspaceSkills = createPromptBudgetWorkspaceSkills();
    const desktopTools = buildPromptBudgetDesktopTools(workspaceSkills);
    const eagerTools = {
      ...createAssistantSkillTools(workspaceSkills),
      ...desktopTools,
    };
    const criticalTools = Object.fromEntries(
      Object.entries(eagerTools).filter(
        ([toolId]) =>
          NATIVE_TOOL_DEFAULTS[toolId as keyof typeof NATIVE_TOOL_DEFAULTS].loadingTier ===
          'critical'
      )
    );
    const eagerProviderTools = buildAuthoredProviderFunctionTools(eagerTools);
    const criticalProviderTools = buildAuthoredProviderFunctionTools(criticalTools);
    const sessionProviderTools = eagerProviderTools.filter((tool) =>
      tool.function.name.includes('CommandSession')
    );
    const queryDiagnosticsProviderTool = eagerProviderTools.find((tool) =>
      tool.function.name.includes('queryDiagnostics')
    );
    if (!queryDiagnosticsProviderTool) {
      throw new Error('queryDiagnostics provider definition is missing');
    }
    const manageCanvasProviderTool = eagerProviderTools.find((tool) =>
      tool.function.name.includes('manageCanvas')
    );
    if (!manageCanvasProviderTool) {
      throw new Error('manageCanvas provider definition is missing');
    }
    const manageWorktreeProviderTool = eagerProviderTools.find((tool) =>
      tool.function.name.includes('manageWorktree')
    );
    if (!manageWorktreeProviderTool) {
      throw new Error('manageWorktree provider definition is missing');
    }
    for (const tool of sessionProviderTools) {
      const properties = asRecord(asRecord(tool.function.parameters)?.['properties']);
      expect(
        asRecord(properties?.['operation'])?.['oneOf'],
        `${tool.function.name} must keep its action-specific fields in a nested union`
      ).toEqual(expect.any(Array));
    }

    // BST-927/BST-980: the two AGGREGATE token figures get the same +/-150
    // band as the surface gates — an exact aggregate here made the band's
    // headroom unreachable (any description edit still failed this suite at
    // this line). COUNTS stay exact: eagerToolCount is the precise
    // dropped-tool catcher, and the per-tool pins below are targeted (they
    // only move when THAT tool's authored text moves — record the trade).
    const eagerDefinitionTokens = countO200kTokens(JSON.stringify(eagerProviderTools));
    const criticalDefinitionTokens = countO200kTokens(JSON.stringify(criticalProviderTools));
    // BST-1176: +400/+400 with the three browser-pane tools (measured 8977;
    // ~150 headroom, width 300 — same doctrine as the authored pair above).
    // BST-1392: +347/+347 for the two worktree tools (measured 9490; width 300).
    // HEADROOM RESTORATION (review round, same day): that raise landed
    // measured EXACTLY at the new MAX (9490/9490) — zero headroom, same
    // hair-trigger failure mode as the authored band above. A first attempt
    // moved both bounds by only +18, leaving the measurement at 94% of the
    // band; re-reviewed and corrected to the BST-1176 precedent (~150
    // headroom): both bounds move +150 from the ORIGINAL post-raise values
    // (9490 → 9640, 9190 → 9340), width 300 unchanged, putting the unchanged
    // 9490 measurement at the band's MIDPOINT.
    // BST-1995: `querySelf` removed; the eager aggregate measured 8952, so both
    // bounds move to centre it (9340 → 8802, 9640 → 9102), width 300 unchanged.
    expect(
      eagerDefinitionTokens,
      'eager aggregate outside its recorded band'
    ).toBeGreaterThanOrEqual(8802);
    expect(eagerDefinitionTokens, 'eager aggregate outside its recorded band').toBeLessThanOrEqual(
      9102
    );
    expect(
      criticalDefinitionTokens,
      'critical aggregate outside its recorded band'
    ).toBeGreaterThanOrEqual(2016);
    expect(
      criticalDefinitionTokens,
      'critical aggregate outside its recorded band'
    ).toBeLessThanOrEqual(2316);
    expect({
      criticalToolCount: criticalProviderTools.length,
      eagerToolCount: eagerProviderTools.length,
      manageCanvasDefinitionTokens: countO200kTokens(JSON.stringify(manageCanvasProviderTool)),
      manageWorktreeDefinitionTokens: countO200kTokens(JSON.stringify(manageWorktreeProviderTool)),
      queryDiagnosticsDefinitionTokens: countO200kTokens(
        JSON.stringify(queryDiagnosticsProviderTool)
      ),
      sessionDefinitionTokens: Object.fromEntries(
        sessionProviderTools.map((tool) => [
          tool.function.name,
          countO200kTokens(JSON.stringify(tool)),
        ])
      ),
    }).toEqual({
      criticalToolCount: 8,
      // Two deferred session tools add 809 authored-definition tokens while
      // leaving the critical request unchanged. Their nested unions
      // prevent providers from filling fields that belong to another action.
      // +358 / +1 for the deferred `querySelf` (BST-913); the critical request
      // is unchanged, since it is not a critical-tier tool. The description
      // carries a stats-flush warning because PGlite's pg_stat_* counters read
      // ZERO until flushed — without it the model reports "no index is ever
      // used", and a confidently wrong tuning answer is worse than a missing one.
      // +44 for the hybrid-arm idioms (BST-935): the BM25 operator and index
      // name are NOT discoverable via describeTable, so without this line the
      // model cannot write the BM25 arm at all.
      // +105 for the lens modes (BST-921): two enum values, the lens/values
      // fields, and the discovery sentence.
      // +350 / +1 for deferred `queryDiagnostics` (BST-853); the critical
      // request remains unchanged.
      // +9 for the grepSearch `filePaths` contract (BST-764): the parameter
      // said only "Restrict to these file paths" and never stated whether the
      // paths were workspace-relative, so models passed absolute paths and got
      // a clean zero-match. The wording is terse on purpose — the first draft
      // spent 38 tokens and overran the authored budget by 25 (BST-927 called
      // this: ~13 tokens of headroom left).
      // +210 / +1 for deferred `manageCanvas` (BST-1173); the strict root
      // object preserves provider compatibility while a discriminated union
      // enforces action-specific fields.
      // Recorded aggregates after BST-1173: eager 8593, critical
      // 2166 (the banded assertions above; move the recorded figures WITH any
      // deliberate raise, per the trade-record practice).
      // −1 for the removed `querySelf` (BST-1995), with its +358/+44/+105 above.
      eagerToolCount: 38,
      // 210 → 234 after the PR #2294 review round: 8 MB `.max()` DoS caps on
      // html/oldString/newString (+500-char titles) serialize into the
      // provider schema, and the description now states that `list` returns
      // summaries, never content. Both are deliberate hardening spends.
      //
      // 234 → 254: the five canvas html descriptions now say "(max 8 MB of
      // UTF-8)". The emitted `maxLength: 8000000` is a CHARACTER count and the
      // enforced ceiling is bytes, so without this the model was told a limit
      // roughly four times looser than the one it will actually hit — a 2.1M
      // emoji document sits inside `maxLength` and is refused. Twenty tokens to
      // stop the model discovering the real unit from a failed call.
      //
      // 254 → 290 (canvas contract, 2026-09-15): the description now says
      // `create` needs content and the write IS the deliverable — never an
      // empty or placeholder canvas, call create once when the content is
      // ready. Live-app verifier runs 6 and 7 pre-created an empty shell
      // behind one approval and wrote the report behind a second; the
      // `empty_document` refusal closes the literal shell and these 36 tokens
      // close the stub. Trim-first was applied: the unpinned "to fill in
      // later" clause was dropped (-4). Measured full authored surface
      // 10353 → 10389 (7 tokens of headroom left under the UNCHANGED 10,396
      // ceiling — the 107 between the recorded 10246 and 10353 is earlier
      // drift, not this change). The band is deliberately NOT raised:
      // `docs/agents/assistant-providers.md` (2026-09-04) keeps the ceilings
      // pending BST-1633 and raises only when the ceiling fires, after a trim.
      manageCanvasDefinitionTokens: 290,
      manageWorktreeDefinitionTokens: 278,
      queryDiagnosticsDefinitionTokens: 351,
      sessionDefinitionTokens: {
        brainstrike_inspectCommandSessions: 327,
        brainstrike_manageCommandSession: 482,
      },
    });
  });

  it('keeps the authored full hosted registry and instructions within the 9,675-9,975 o200k band', async () => {
    expect(PROVIDER_DEFAULT_MODELS.openrouter).toBe(OPENROUTER_PROMPT_BUDGET_MODEL);
    const workspaceSkills = createPromptBudgetWorkspaceSkills();
    const desktopTools = buildPromptBudgetDesktopTools(workspaceSkills);
    const authoredTools = {
      ...createAssistantSkillTools(workspaceSkills),
      ...desktopTools,
    };
    const providerSurface = snapshotProviderToolSurface(authoredTools);
    const runtime = await createMastraAgentRuntime({
      model: OPENROUTER_PROMPT_BUDGET_MODEL,
      runtime: {
        apiKey: 'prompt-budget-test-key',
        provider: 'openrouter',
        workspaceSkills,
      },
      tools: omitNonProviderSuspendMetadata(desktopTools),
    });

    try {
      const resolvedInstructions = await runtime.agent.getInstructions();
      if (typeof resolvedInstructions !== 'string') {
        throw new TypeError('Brainstrike hosted instructions must resolve to one string');
      }
      const providerTools = buildProviderFunctionTools(providerSurface, runtime.toolNameMap);
      expectProviderSurfaceWithinBudget({
        budget: MAX_AUTHORED_NATIVE_TOOL_TOKENS,
        floor: MIN_AUTHORED_NATIVE_TOOL_TOKENS,
        instructions: withSkillsProcessorContext(resolvedInstructions),
        label: 'Authored native tool surface',
        tools: providerTools,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps the actual Mastra/OpenRouter initial core surface materially below the eager baseline', async () => {
    expect(PROVIDER_DEFAULT_MODELS.openrouter).toBe(OPENROUTER_PROMPT_BUDGET_MODEL);
    const workspaceSkills = createPromptBudgetWorkspaceSkills();
    const desktopTools = buildPromptBudgetDesktopTools(workspaceSkills);
    const runtime = await createMastraAgentRuntime({
      model: OPENROUTER_PROMPT_BUDGET_MODEL,
      runtime: {
        apiKey: 'prompt-budget-test-key',
        provider: 'openrouter',
        workspaceSkills,
      },
      tools: omitNonProviderSuspendMetadata(desktopTools),
    });

    try {
      const resolvedInstructions = await runtime.agent.getInstructions();
      if (typeof resolvedInstructions !== 'string') {
        throw new TypeError('Brainstrike hosted instructions must resolve to one string');
      }
      const coreTools = await runtime.agent.getToolsForExecution({});
      const providerTools = Object.entries(coreTools).map(([name, tool]) => {
        const originalName = runtime.toolNameMap.get(name);
        if (!originalName) {
          throw new Error(`Mastra returned unmapped initial tool ${name}`);
        }
        if (typeof tool.description !== 'string') {
          throw new TypeError(`Mastra tool ${name} lacks a description`);
        }
        const parameters = tool.parameters;
        if (!parameters || typeof parameters !== 'object' || !('jsonSchema' in parameters)) {
          throw new TypeError(`Mastra tool ${name} lacks provider JSON Schema`);
        }
        if (parameters.jsonSchema === undefined) {
          throw new TypeError(`Mastra tool ${name} has undefined provider JSON Schema`);
        }
        return {
          function: {
            description: tool.description,
            name,
            parameters: parameters.jsonSchema,
          },
          type: 'function' as const,
        };
      });

      const skillToolIds = new Set(Object.keys(createAssistantSkillTools(workspaceSkills)));
      const expectedCoreIds = Object.entries(NATIVE_TOOL_DEFAULTS)
        .filter(
          ([toolId, metadata]) =>
            metadata.loadingTier === 'critical' ||
            skillToolIds.has(toolId) ||
            toolId === NATIVE_TOOL_ID.readToolOutputArtifact
        )
        .map(([toolId]) => toolId)
        .sort();
      expect(runtime.toolDiscovery?.coreToolIds.slice().sort()).toEqual(expectedCoreIds);
      expect(providerTools.map((tool) => tool.function.name).sort()).toEqual(
        expectedCoreIds.map((toolId) => toolId.replace(/[^a-zA-Z0-9_-]/g, '_')).sort()
      );
      expect(runtime.toolDiscovery?.deferredToolIds).toHaveLength(
        Object.keys(NATIVE_TOOL_DEFAULTS).length - expectedCoreIds.length
      );

      expectProviderSurfaceWithinBudget({
        budget: MAX_MASTRA_OPENROUTER_INITIAL_CORE_TOKENS,
        floor: MIN_MASTRA_OPENROUTER_INITIAL_CORE_TOKENS,
        instructions: withSkillsProcessorContext(resolvedInstructions),
        label: 'Actual Mastra/OpenRouter initial core surface',
        tools: providerTools,
      });
    } finally {
      await runtime.dispose();
    }
  });
});
