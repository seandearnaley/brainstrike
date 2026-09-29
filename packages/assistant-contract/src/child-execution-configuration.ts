import { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/types';
import { z } from 'zod';
import { findProviderDefinition } from './provider-registry.js';

const id = z.string().trim().min(1).max(512);
const provider = id.refine((value) => findProviderDefinition(value) !== undefined);
const effort = z.enum(OPENAI_REASONING_EFFORT_VALUES);
const summary = z.enum(['auto', 'detailed']);
const count = z.number().int().nonnegative();
/** The same generation fields represented by RuntimeData; transport credentials are excluded. */
export const childGenerationOptionsSchema = z.strictObject({
  anthropic: z
    .strictObject({
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      thinking: z
        .discriminatedUnion('type', [
          z.strictObject({
            display: z.enum(['omitted', 'summarized', 'updates']).optional(),
            type: z.literal('adaptive'),
          }),
          z.strictObject({ budgetTokens: count, type: z.literal('enabled') }),
          z.strictObject({ type: z.literal('disabled') }),
        ])
        .optional(),
    })
    .optional(),
  bedrock: z
    .strictObject({
      reasoningConfig: z
        .strictObject({
          budgetTokens: count.optional(),
          display: z.enum(['omitted', 'summarized']).optional(),
          maxReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
          type: z.enum(['adaptive', 'disabled', 'enabled']),
        })
        .optional(),
    })
    .optional(),
  google: z
    .strictObject({
      thinkingConfig: z
        .strictObject({
          includeThoughts: z.boolean().optional(),
          thinkingBudget: z.number().int().min(-1).optional(),
          thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
        })
        .optional(),
    })
    .optional(),
  local: z
    .strictObject({ thinking: z.strictObject({ enabled: z.boolean().optional() }).optional() })
    .optional(),
  openai: z
    .strictObject({ reasoningEffort: effort.optional(), reasoningSummary: summary.optional() })
    .optional(),
  openrouter: z
    .strictObject({
      // biome-ignore lint/style/useNamingConvention: OpenRouter wire field.
      provider: z.strictObject({ require_parameters: z.literal(true) }),
      reasoning: z
        .strictObject({
          effort: effort.optional(),
          enabled: z.boolean().optional(),
          exclude: z.boolean().optional(),
          summary: summary.optional(),
        })
        .optional(),
    })
    .optional(),
});
export const childModelSettingsSchema = z.strictObject({
  frequencyPenalty: z.number().finite().optional(),
  maxOutputTokens: count.positive().optional(),
  presencePenalty: z.number().finite().optional(),
  temperature: z.number().finite().optional(),
  topP: z.number().finite().optional(),
});
/** Requested settings can only reduce tools. The caller cannot supply a permission snapshot. */
export const childNextRunSchema = z.strictObject({
  disabledToolIds: z.array(id).optional(),
  model: z.strictObject({ modelId: id, provider }).optional(),
  modelSettings: childModelSettingsSchema.optional(),
  planMode: z.boolean().optional(),
  providerOptions: childGenerationOptionsSchema.optional(),
  requestedReasoningEffort: effort.optional(),
});
export type ChildNextRun = z.output<typeof childNextRunSchema>;
const decision = z.enum(['allow', 'ask', 'deny']);
const risk = z.enum(['read', 'edit', 'execute', 'mcp']);
const permissionSchema = z.strictObject({
  defaultRisk: risk.optional(),
  perToolOverrides: z.record(z.string(), decision).optional(),
  policies: z.strictObject({ edit: decision, execute: decision, mcp: decision, read: decision }),
  riskByTool: z.record(z.string(), risk).optional(),
  sessionGrants: z.array(risk).optional(),
  yolo: z.boolean(),
});
export const childExecutionConfigurationSchema = z.strictObject({
  model: id,
  modelSettings: childModelSettingsSchema.optional(),
  permissionPolicy: permissionSchema.optional(),
  planMode: z.boolean(),
  provider,
  providerOptions: childGenerationOptionsSchema.optional(),
  requestedReasoningEffort: effort.optional(),
});
export type ChildExecutionConfiguration = Defined<
  z.output<typeof childExecutionConfigurationSchema>
>;
export function readChildExecutionConfiguration(value: unknown): ChildExecutionConfiguration {
  return omitUndefined(childExecutionConfigurationSchema.parse(value));
}

// Zod's optional fields admit explicit undefined; RuntimeData's exact optional
// contract admits only absence. Preserve every defined value while normalizing that boundary.
type Defined<T> = T extends readonly (infer Item)[]
  ? Defined<Item>[]
  : T extends object
    ? {
        [Key in keyof T]: Defined<Exclude<T[Key], undefined>>;
      }
    : T;
function omitUndefined<T>(value: T): Defined<T> {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => omitUndefined(item)) as Defined<T>;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, omitUndefined(item)])
    ) as Defined<T>;
  }
  return value as Defined<T>;
}
