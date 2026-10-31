/**
 * The tools a Main admission offers a host run, described from the catalog and
 * the admitted state alone. Main builds no tool: the agent host executes every
 * one of them from these descriptors (b74a3a77c).
 */
import { createSanitizedToolNameMap } from '@brainstrike/agent/tool-runtime';
import { canonicalToolInputJsonSchema, type HostTool } from '@brainstrike/agent-host';
import {
  DESKTOP_NATIVE_TOOLS,
  isDesktopNativeToolId,
  NATIVE_TOOL_ID,
  resolveToolRiskCategory,
  SKILL_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import {
  AskUserResumeSchema,
  type EffectToolInputSchema,
  SubmitPlanResumeSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import type { IndexerStatus } from '@brainstrike/indexing-contract/indexer-client';
import { Schema } from 'effect';
import type { PlatformSelectionSchema } from './platform-wire';

export type DesktopToolDescriptor = (typeof PlatformSelectionSchema)['Encoded']['tools'][string];

/** What an admission decided that changes which tools exist. */
export interface DesktopToolAdmission {
  /**
   * BST-2360: this host runs code inside the OS fence. run_python runs nowhere
   * else, so a host without one (Windows) leaves it out of the run instead of
   * asking the person to approve a call that cannot run.
   */
  readonly codeFence: boolean;
  readonly enabledNativeToolIds: readonly string[];
  /** ADR 0026: Main's index can serve semantic retrieval over the thread's folders. */
  readonly retrieval: boolean;
  /** The run's scanned workspace skills: the skill tools and runSkillScript exist only with them. */
  readonly skills: boolean;
}

/**
 * The retrieval lane (ADR 0026). listEmbeddingSpaces lists the collections
 * these two search, so it goes with them; readWorkspaceContext reads the disk.
 */
const RETRIEVAL_TOOL_IDS: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
]);

/**
 * Whether the index status a run starts with can serve semantic retrieval:
 * ready, in VECTOR mode, with a saved collection, over one of the thread's
 * folders. The tools' own refusals still cover a change during the run.
 */
export function indexServesRetrieval(
  status: IndexerStatus,
  threadRootIds: readonly string[]
): boolean {
  return (
    status.kind === 'ready' &&
    status.embedding.indexMode === 'vector-configured' &&
    (status.authorizedCollectionIds?.length ?? 0) > 0 &&
    threadRootIds.some((rootId) => status.authorizedRootIds.includes(rootId))
  );
}

/** The two suspending tools answer with a person's resume, as Core's question and plan. */
const INTERACTIONS: Readonly<
  Record<
    string,
    { readonly kind: 'question' | 'plan'; readonly resumeSchema: EffectToolInputSchema<unknown> }
  >
> = {
  [NATIVE_TOOL_ID.askUser]: { kind: 'question', resumeSchema: AskUserResumeSchema },
  [NATIVE_TOOL_ID.submitPlan]: { kind: 'plan', resumeSchema: SubmitPlanResumeSchema },
};

function admitted(id: string, admission: DesktopToolAdmission): boolean {
  if (id === NATIVE_TOOL_ID.runPython) {
    return admission.codeFence;
  }
  if (id === NATIVE_TOOL_ID.runSkillScript) {
    return admission.skills;
  }
  return !RETRIEVAL_TOOL_IDS.has(id) || admission.retrieval;
}

const JsonSchemaSchema = Schema.Record(Schema.String, Schema.MutableJson);

async function jsonSchema(
  schema: HostTool['inputSchema']
): Promise<(typeof JsonSchemaSchema)['Type']> {
  return wireDecoder(JsonSchemaSchema, { errors: 'all', onExcessProperty: 'error' })(
    await canonicalToolInputJsonSchema(schema)
  );
}

async function describe(id: string): Promise<DesktopToolDescriptor> {
  const definition = NATIVE_TOOL_REGISTRIES.byId[id as keyof typeof NATIVE_TOOL_REGISTRIES.byId];
  const interaction = INTERACTIONS[id];
  return {
    // A skill tool's wire text is its compact provider description.
    description:
      definition.kind === 'skill' ? definition.providerDescription : definition.description,
    identity: id,
    inputSchema: await jsonSchema(definition.inputSchema),
    ...(interaction
      ? {
          interaction: {
            kind: interaction.kind,
            resumeSchema: await jsonSchema(interaction.resumeSchema),
          },
        }
      : {}),
    permissionToolId: id,
    risk: resolveToolRiskCategory(definition.defaults),
  };
}

/**
 * The admission's tools keyed by their provider names: the enabled native
 * tools its rules keep, then the skill tools when the run scanned skills.
 */
export async function desktopToolDescriptors(
  admission: DesktopToolAdmission
): Promise<Record<string, DesktopToolDescriptor>> {
  if (admission.enabledNativeToolIds.some((id) => !isDesktopNativeToolId(id))) {
    throw new Error('Enabled native tool preferences contain unknown tool IDs.');
  }
  const enabled = new Set(admission.enabledNativeToolIds);
  const ids = [
    ...DESKTOP_NATIVE_TOOLS.map((tool) => tool.id).filter(
      (id) => enabled.has(id) && admitted(id, admission)
    ),
    ...(admission.skills ? SKILL_NATIVE_TOOL_IDS : []),
  ];
  return Object.fromEntries(
    await Promise.all(
      [...createSanitizedToolNameMap(ids)].map(
        async ([name, id]) => [name, await describe(id)] as const
      )
    )
  );
}
