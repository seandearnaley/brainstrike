import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
  NATIVE_TOOL_IDS,
  NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS,
  SKILL_NATIVE_TOOL_IDS,
  WEB_NATIVE_TOOL_IDS,
} from '../native-tool-catalog';
import {
  type DesktopNativeToolDefinition,
  defineNativeTool,
  InvalidNativeToolDefinitionError,
  type NativeToolDefinition,
} from '../native-tools/define';
import { DESKTOP_NATIVE_TOOLS, NATIVE_TOOL_REGISTRIES, NATIVE_TOOLS } from '../native-tools/index';

/** The catalog seen through its declared (non-literal) definition types. */
const CATALOG: readonly NativeToolDefinition[] = NATIVE_TOOLS;
const DESKTOP_CATALOG: readonly DesktopNativeToolDefinition[] = DESKTOP_NATIVE_TOOLS;

import { deriveNativeToolRegistries } from '../native-tools/registries';
import {
  effectToolInputSchema,
  isEffectToolInputSchema,
} from '../native-tools/schemas/effect-tool-input';
import { NATIVE_TOOL_DEFAULTS } from '../tool-categories';
import { TOOL_DESCRIPTIONS } from '../tool-descriptions';
import { NATIVE_TOOL_DISCOVERY_NAMESPACES } from '../tool-discovery';
import { UndeterminableToolRiskError } from '../tool-risk';

/**
 * The ONE inline snapshot of the catalog. This replaces the two hand-copied
 * 36-id lists that used to live in `native-tool-catalog.test.ts` and
 * `native-tool-input-schema-catalog.spec.ts`: adding or renaming a tool
 * updates this snapshot deliberately, in one place.
 */
describe('NATIVE_TOOLS catalog', () => {
  it('registers every search/artifact tool through the Effect producer', () => {
    const expected = [
      'hybridSearch',
      'queryEmbeddingSpace',
      'grepSearch',
      'globWorkspace',
      'webSearch',
      'webExtract',
      'lspInspect',
      'readToolOutputArtifact',
    ];
    const selected = CATALOG.filter((tool) =>
      expected.includes(tool.id.replace('brainstrike.', ''))
    );
    expect(selected.map((tool) => tool.id.replace('brainstrike.', '')).sort()).toEqual(
      [...expected].sort()
    );
    for (const tool of selected) {
      expect(isEffectToolInputSchema(tool.inputSchema), tool.id).toBe(true);
    }
  });

  it('is the single ordered list of native tool ids', () => {
    expect(NATIVE_TOOLS.map((tool) => tool.id)).toMatchInlineSnapshot(`
      [
        "brainstrike.askUser",
        "brainstrike.browserGetPageText",
        "brainstrike.browserNavigate",
        "brainstrike.browserReadPage",
        "brainstrike.deleteWorkspaceFile",
        "brainstrike.executeCommand",
        "brainstrike.findWorkspaceSymbol",
        "brainstrike.globWorkspace",
        "brainstrike.grepSearch",
        "brainstrike.hybridSearch",
        "brainstrike.inspectCommandSessions",
        "brainstrike.listEmbeddingSpaces",
        "brainstrike.listWorkspaceContext",
        "brainstrike.listWorktrees",
        "brainstrike.lspInspect",
        "brainstrike.manageCanvas",
        "brainstrike.manageCommandSession",
        "brainstrike.manageTaskList",
        "brainstrike.manageWorktree",
        "brainstrike.queryDiagnostics",
        "brainstrike.queryEmbeddingSpace",
        "brainstrike.readToolOutputArtifact",
        "brainstrike.readWorkspaceContext",
        "brainstrike.readWorkspaceDirectory",
        "brainstrike.readWorkspaceFile",
        "brainstrike.renameWorkspaceFile",
        "brainstrike.runPython",
        "brainstrike.runSkillScript",
        "brainstrike.stringReplaceWorkspaceFile",
        "brainstrike.submitPlan",
        "brainstrike.webExtract",
        "brainstrike.webSearch",
        "brainstrike.writeWorkspaceFile",
        "skill",
        "skill_read",
        "skill_search",
      ]
    `);
  });

  it('partitions desktop (brainstrike.*) and skill ids exactly, with no duplicates', () => {
    expect(DESKTOP_NATIVE_TOOL_IDS).toHaveLength(33);
    expect(SKILL_NATIVE_TOOL_IDS).toEqual(['skill', 'skill_read', 'skill_search']);
    expect(NATIVE_TOOL_IDS).toEqual([...DESKTOP_NATIVE_TOOL_IDS, ...SKILL_NATIVE_TOOL_IDS]);
    expect(new Set(NATIVE_TOOL_IDS).size).toBe(NATIVE_TOOL_IDS.length);
    expect(NATIVE_TOOL_IDS).toEqual(NATIVE_TOOLS.map((tool) => tool.id));
  });

  it('keys NATIVE_TOOL_ID by the catalog key of every definition', () => {
    expect(Object.values(NATIVE_TOOL_ID)).toEqual(NATIVE_TOOL_IDS);
    expect(NATIVE_TOOL_ID.skillRead).toBe('skill_read');
    expect(NATIVE_TOOL_ID.grepSearch).toBe('brainstrike.grepSearch');
  });

  it('derives the surface partitions from each definition instead of a second list', () => {
    expect(WEB_NATIVE_TOOL_IDS).toEqual(
      DESKTOP_CATALOG.filter((tool) => tool.surfaces.includes('web')).map((tool) => tool.id)
    );
    expect(WEB_NATIVE_TOOL_IDS).toHaveLength(22);
    expect(LOCAL_DESKTOP_NATIVE_TOOL_IDS).toEqual([
      'brainstrike.executeCommand',
      'brainstrike.globWorkspace',
      'brainstrike.grepSearch',
      'brainstrike.readWorkspaceFile',
      'brainstrike.stringReplaceWorkspaceFile',
    ]);
    expect([...LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS]).toEqual(
      DESKTOP_CATALOG.filter((tool) => tool.localProvider === 'unregistered').map((tool) => tool.id)
    );
    expect([...LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS].sort()).toEqual([
      'brainstrike.askUser',
      'brainstrike.browserGetPageText',
      'brainstrike.browserNavigate',
      'brainstrike.browserReadPage',
      'brainstrike.inspectCommandSessions',
      'brainstrike.listWorktrees',
      'brainstrike.manageCanvas',
      'brainstrike.manageCommandSession',
      'brainstrike.manageTaskList',
      'brainstrike.manageWorktree',
      'brainstrike.runPython',
      'brainstrike.submitPlan',
    ]);
    expect(NON_DURABLE_NATIVE_TOOL_OUTPUT_IDS).toEqual([
      'brainstrike.inspectCommandSessions',
      'brainstrike.manageCommandSession',
    ]);
  });

  it('keeps every browser-safe registry in exact parity with the catalog by construction', () => {
    expect(Object.keys(TOOL_DESCRIPTIONS)).toEqual(NATIVE_TOOL_IDS);
    expect(Object.keys(NATIVE_TOOL_DEFAULTS)).toEqual(NATIVE_TOOL_IDS);
    for (const tool of NATIVE_TOOLS) {
      expect(TOOL_DESCRIPTIONS[tool.id]).toBe(tool.description);
      expect(NATIVE_TOOL_DEFAULTS[tool.id]).toBe(tool.defaults);
    }
  });

  it('places every deferred tool in exactly one discovery namespace and no critical tool in any', () => {
    const namespaced = Object.values(NATIVE_TOOL_DISCOVERY_NAMESPACES).flatMap(
      ({ toolIds }) => toolIds
    );
    expect(new Set(namespaced).size).toBe(namespaced.length);
    expect([...namespaced].sort()).toEqual(
      CATALOG.filter((tool) => tool.defaults.loadingTier !== 'critical')
        .map((tool) => tool.id)
        .sort()
    );
  });

  it('derives the deferred capability families in emission order', () => {
    const families = NATIVE_TOOL_REGISTRIES.capabilityFamilies;
    expect(families.map((family) => family.phrase)).toMatchInlineSnapshot(`
      [
        "canvas documents",
        "task lists",
        "skill scripts",
        "Python",
        "browser pages",
        "web search/extract",
        "command sessions",
        "git worktrees",
        "file delete/rename",
        "directory listings",
        "workspace context",
        "symbol and LSP inspection",
        "embedding search",
        "diagnostics",
        "tool-output artifacts",
      ]
    `);
    for (const family of families) {
      expect(family.ids.length, family.phrase).toBeGreaterThan(0);
      for (const id of family.ids) {
        expect(CATALOG.find((tool) => tool.id === id)?.discovery?.family).toBe(family.phrase);
      }
    }
  });
});

const throwawayTool = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 42,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description: 'A throwaway tool that exists only to prove derivation covers every registry.',
  discovery: { family: 'diagnostics', namespace: 'database' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.throwawayProbe',
  inputSchema: effectToolInputSchema(
    Schema.Struct({ probe: Schema.String.annotate({ description: 'Probe input' }) })
  ),
  kind: 'desktop',
  localProvider: 'offered',
  nonDurableOutput: true,
  returns: 'Nothing useful.',
  surfaces: ['desktop', 'web'],
});

describe('deriveNativeToolRegistries', () => {
  const registries = deriveNativeToolRegistries([...NATIVE_TOOLS, throwawayTool]);

  it('lands a new definition in EVERY derived registry with no other edit', () => {
    const id = throwawayTool.id;
    expect(registries.byId[id]).toBe(throwawayTool);
    expect(registries.nativeToolId.throwawayProbe).toBe(id);
    expect(registries.descriptions[id]).toBe(throwawayTool.description);
    expect(registries.defaults[id]).toBe(throwawayTool.defaults);
    expect(registries.ids.native).toContain(id);
    expect(registries.ids.desktop).toContain(id);
    expect(registries.ids.skill).not.toContain(id);
    expect(registries.ids.web).toContain(id);
    expect(registries.ids.local).toContain(id);
    expect(registries.ids.localUnregistered).not.toContain(id);
    expect(registries.ids.nonDurableOutput).toContain(id);
    expect(registries.ids.recencyPrunable).toContain(id);
    expect(registries.ids.staleReplayable).toContain(id);
    expect(registries.discoveryNamespaceToolIds.database).toContain(id);
    expect(
      registries.capabilityFamilies.find((family) => family.phrase === 'diagnostics')?.ids
    ).toContain(id);
  });

  it('leaves the real catalog registries unchanged by the probe', () => {
    expect(registries.ids.native.slice(0, -1)).toEqual(NATIVE_TOOL_IDS);
  });

  it('refuses a duplicate id', () => {
    expect(() => deriveNativeToolRegistries([...NATIVE_TOOLS, NATIVE_TOOLS[0]])).toThrow(
      /declares brainstrike\.askUser twice/
    );
  });
});

describe('defineNativeTool fail-loud checks', () => {
  const base = {
    description: 'probe',
    id: 'brainstrike.probe',
    inputSchema: effectToolInputSchema(Schema.Struct({})),
    kind: 'desktop',
    returns: 'probe',
    surfaces: ['desktop'],
  } as const;

  it('throws UndeterminableToolRiskError for an action tool without an explicit risk bucket', () => {
    expect(() =>
      defineNativeTool({
        ...base,
        defaults: {
          category: 'action',
          estimatedTokens: 1,
          loadingTier: 'deferred',
          requiresApproval: true,
        },
        discovery: { namespace: 'workspace' },
      })
    ).toThrow(UndeterminableToolRiskError);
  });

  it('throws when a deferred tool has no discovery namespace', () => {
    expect(() =>
      defineNativeTool({
        ...base,
        defaults: {
          category: 'retrieval',
          estimatedTokens: 1,
          loadingTier: 'deferred',
          requiresApproval: false,
        },
      })
    ).toThrow(InvalidNativeToolDefinitionError);
  });

  it('throws when a deferred desktop tool declares a namespace but no capability family', () => {
    // Without a family the tool sits behind search_tools with no advertised
    // capability line: reachable in principle, undiscoverable in practice.
    expect(() =>
      defineNativeTool({
        ...base,
        defaults: {
          category: 'retrieval',
          estimatedTokens: 1,
          loadingTier: 'deferred',
          requiresApproval: false,
        },
        discovery: { namespace: 'workspace' },
      })
    ).toThrow(InvalidNativeToolDefinitionError);
  });

  it('throws when a critical tool declares a discovery namespace', () => {
    expect(() =>
      defineNativeTool({
        ...base,
        defaults: {
          category: 'retrieval',
          estimatedTokens: 1,
          loadingTier: 'critical',
          requiresApproval: false,
        },
        discovery: { namespace: 'workspace' },
      })
    ).toThrow(InvalidNativeToolDefinitionError);
  });
});
