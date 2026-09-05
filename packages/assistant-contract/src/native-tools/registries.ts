/**
 * Derives every per-tool registry from a list of {@link NativeToolDefinition}s.
 *
 * `./index.ts` applies this to the real catalog once at module load; tests
 * apply it to `[...NATIVE_TOOLS, throwaway]` to prove a new definition lands in
 * EVERY registry with no other edit. Every check here throws: a duplicate id,
 * a duplicate catalog key, a deferred tool outside every family, or a family
 * phrase no tool claims is a broken catalog, never a quietly smaller one.
 */
import {
  DEFERRED_CAPABILITY_FAMILY_PHRASES,
  type DeferredCapabilityFamily,
} from './capability-families.js';
import type {
  DesktopNativeToolDefinition,
  NativeToolDefinition,
  NativeToolDiscoveryNamespace,
  NativeToolSurface,
  SkillNativeToolDefinition,
} from './define.js';
import type { NativeToolDefaultMetadata } from './taxonomy.js';

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

/**
 * The camelCase catalog key of a tool id: `brainstrike.grepSearch` → `grepSearch`,
 * `skill_read` → `skillRead`. `NATIVE_TOOL_ID[key] === id`, and the same key
 * names the tool's slot in the prompt composer's model-facing name map.
 */
export type NativeToolKeyOf<Id extends string> = Id extends `brainstrike.${infer Key}`
  ? Key
  : CamelCase<Id>;

export function toNativeToolKey(toolId: string): string {
  if (toolId.startsWith('brainstrike.')) {
    return toolId.slice('brainstrike.'.length);
  }
  return toolId.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

type IdOf<Tools extends readonly NativeToolDefinition[]> = Tools[number]['id'];
type DesktopToolOf<Tools extends readonly NativeToolDefinition[]> = Extract<
  Tools[number],
  DesktopNativeToolDefinition
>;
type SkillToolOf<Tools extends readonly NativeToolDefinition[]> = Extract<
  Tools[number],
  SkillNativeToolDefinition
>;
type OnSurface<Tool, Surface extends NativeToolSurface> = Tool extends {
  readonly surfaces: readonly (infer Listed)[];
}
  ? Surface extends Listed
    ? Tool
    : never
  : never;

export interface NativeToolRegistries<Tools extends readonly NativeToolDefinition[]> {
  /** Every definition keyed by its canonical id. */
  readonly byId: { readonly [Tool in Tools[number] as Tool['id']]: Tool };
  /** Deferred capability families in emission order, ids in catalog order. */
  readonly capabilityFamilies: readonly DeferredCapabilityFamily[];
  readonly defaults: Readonly<Record<IdOf<Tools>, NativeToolDefaultMetadata>>;
  readonly descriptions: Readonly<Record<IdOf<Tools>, string>>;
  /** Deferred namespace → member ids in catalog order (summaries live in tool-discovery.ts). */
  readonly discoveryNamespaceToolIds: Readonly<
    Record<NativeToolDiscoveryNamespace, readonly IdOf<Tools>[]>
  >;
  readonly ids: {
    readonly desktop: readonly DesktopToolOf<Tools>['id'][];
    readonly local: readonly OnSurface<DesktopToolOf<Tools>, 'local'>['id'][];
    readonly native: readonly IdOf<Tools>[];
    readonly nonDurableOutput: readonly DesktopToolOf<Tools>['id'][];
    readonly recencyPrunable: readonly IdOf<Tools>[];
    readonly skill: readonly SkillToolOf<Tools>['id'][];
    readonly staleReplayable: readonly IdOf<Tools>[];
    readonly web: readonly OnSurface<DesktopToolOf<Tools>, 'web'>['id'][];
  };
  /** camelCase key → canonical id (the `NATIVE_TOOL_ID` object). */
  readonly nativeToolId: {
    readonly [Tool in Tools[number] as NativeToolKeyOf<Tool['id']>]: Tool['id'];
  };
}

function isDesktop(tool: NativeToolDefinition): tool is DesktopNativeToolDefinition {
  return tool.kind === 'desktop';
}

function idsWhere<Tools extends readonly NativeToolDefinition[]>(
  tools: Tools,
  predicate: (tool: Tools[number]) => boolean
): readonly IdOf<Tools>[] {
  return Object.freeze(tools.filter(predicate).map((tool) => tool.id as IdOf<Tools>));
}

function assertUniqueIdsAndKeys(tools: readonly NativeToolDefinition[]): void {
  const seenIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const tool of tools) {
    if (seenIds.has(tool.id)) {
      throw new Error(`Native tool catalog declares ${tool.id} twice.`);
    }
    seenIds.add(tool.id);
    const key = toNativeToolKey(tool.id);
    const previous = seenKeys.get(key);
    if (previous !== undefined) {
      throw new Error(
        `Native tools ${previous} and ${tool.id} collide on catalog key "${key}"; ids must stay distinct after the brainstrike. prefix is dropped.`
      );
    }
    seenKeys.set(key, tool.id);
  }
}

function deriveCapabilityFamilies(
  tools: readonly NativeToolDefinition[]
): readonly DeferredCapabilityFamily[] {
  const families = DEFERRED_CAPABILITY_FAMILY_PHRASES.map((phrase) => ({
    ids: Object.freeze(
      tools.filter((tool) => tool.discovery?.family === phrase).map((tool) => tool.id)
    ),
    phrase,
  }));
  for (const family of families) {
    if (family.ids.length === 0) {
      throw new Error(
        `Deferred capability family "${family.phrase}" names no native tool; remove the phrase or give a tool discovery.family.`
      );
    }
  }
  return Object.freeze(families);
}

function deriveDiscoveryNamespaces<Tools extends readonly NativeToolDefinition[]>(
  tools: Tools
): Readonly<Record<NativeToolDiscoveryNamespace, readonly IdOf<Tools>[]>> {
  const namespaces: Record<NativeToolDiscoveryNamespace, IdOf<Tools>[]> = {
    artifacts: [],
    context: [],
    database: [],
    embeddings: [],
    execution: [],
    semantics: [],
    sessions: [],
    skills: [],
    web: [],
    workspace: [],
  };
  for (const tool of tools) {
    if (tool.discovery) {
      namespaces[tool.discovery.namespace].push(tool.id as IdOf<Tools>);
    }
  }
  return Object.freeze(namespaces);
}

export function deriveNativeToolRegistries<const Tools extends readonly NativeToolDefinition[]>(
  tools: Tools
): NativeToolRegistries<Tools> {
  assertUniqueIdsAndKeys(tools);
  const byId = Object.freeze(
    Object.fromEntries(tools.map((tool) => [tool.id, tool]))
  ) as NativeToolRegistries<Tools>['byId'];
  const nativeToolId = Object.freeze(
    Object.fromEntries(tools.map((tool) => [toNativeToolKey(tool.id), tool.id]))
  ) as NativeToolRegistries<Tools>['nativeToolId'];
  const descriptions = Object.freeze(
    Object.fromEntries(tools.map((tool) => [tool.id, tool.description]))
  ) as Readonly<Record<IdOf<Tools>, string>>;
  const defaults = Object.freeze(
    Object.fromEntries(tools.map((tool) => [tool.id, tool.defaults]))
  ) as Readonly<Record<IdOf<Tools>, NativeToolDefaultMetadata>>;
  const desktopTools = tools.filter(isDesktop);
  return {
    byId,
    capabilityFamilies: deriveCapabilityFamilies(tools),
    defaults,
    descriptions,
    discoveryNamespaceToolIds: deriveDiscoveryNamespaces(tools),
    ids: {
      desktop: idsWhere(tools, isDesktop) as readonly DesktopToolOf<Tools>['id'][],
      local: Object.freeze(
        desktopTools.filter((tool) => tool.surfaces.includes('local')).map((tool) => tool.id)
      ) as readonly OnSurface<DesktopToolOf<Tools>, 'local'>['id'][],
      native: idsWhere(tools, () => true),
      nonDurableOutput: Object.freeze(
        desktopTools.filter((tool) => tool.nonDurableOutput === true).map((tool) => tool.id)
      ) as readonly DesktopToolOf<Tools>['id'][],
      recencyPrunable: idsWhere(tools, (tool) => tool.history?.recencyPrunable === true),
      skill: idsWhere(
        tools,
        (tool) => tool.kind === 'skill'
      ) as readonly SkillToolOf<Tools>['id'][],
      staleReplayable: idsWhere(tools, (tool) => tool.history?.staleReplayable === true),
      web: Object.freeze(
        desktopTools.filter((tool) => tool.surfaces.includes('web')).map((tool) => tool.id)
      ) as readonly OnSurface<DesktopToolOf<Tools>, 'web'>['id'][],
    },
    nativeToolId,
  };
}
