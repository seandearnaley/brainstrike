/**
 * The tools a Main admission offers a host run, described from the catalog and
 * the admitted state alone. Main builds no tool: the agent host executes every
 * one of them from these descriptors (b74a3a77c).
 */
import { createSanitizedToolNameMap } from '@brainstrike/agent/tool-runtime';
import { canonicalToolInputJsonSchema, canonicalToolInputSchema } from '@brainstrike/agent-host';
import {
  DESKTOP_NATIVE_TOOLS,
  isDesktopNativeToolId,
  LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS,
  NATIVE_TOOL_ID,
  resolveToolRiskCategory,
  SKILL_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import {
  AskUserResumeSchema,
  type EffectToolInputSchema,
  SubmitPlanResumeSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';
import { z } from 'zod';
import type { PlatformSelectionSchema } from './platform-wire';

export type DesktopToolDescriptor = (typeof PlatformSelectionSchema)['Encoded']['tools'][string];

/** What an admission decided that changes which tools exist. */
export interface DesktopToolAdmission {
  readonly enabledNativeToolIds: readonly string[];
  /** The built-in on-device provider: its `unregistered` tools have no executor. */
  readonly localProvider: boolean;
  /** The run's scanned workspace skills: the skill tools and runSkillScript exist only with them. */
  readonly skills: boolean;
  /** Main's worktree service: without it the worktree tools cannot run. */
  readonly worktrees: boolean;
}

const WORKTREE_TOOL_IDS: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.listWorktrees,
  NATIVE_TOOL_ID.manageWorktree,
]);

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
  if (admission.localProvider && LOCAL_PROVIDER_UNREGISTERED_NATIVE_TOOL_IDS.has(id)) {
    return false;
  }
  if (id === NATIVE_TOOL_ID.runSkillScript) {
    return admission.skills;
  }
  return !WORKTREE_TOOL_IDS.has(id) || admission.worktrees;
}

const JsonSchemaSchema = z.record(z.string(), z.json());

/**
 * `unknown`, matching `canonicalToolInputSchema`: a tool's registered input
 * schema is authored in Effect Schema or zod (ADR-0004, amended 2026-10-15)
 * and Mastra's `toStandardSchema` admits either. Naming zod here would be a
 * false type for the converted tools.
 */
async function jsonSchema(schema: unknown): Promise<z.output<typeof JsonSchemaSchema>> {
  return JsonSchemaSchema.parse(
    await canonicalToolInputJsonSchema(canonicalToolInputSchema(schema))
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
