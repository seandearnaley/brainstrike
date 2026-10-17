import { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/types';
import { Schema } from 'effect';
import { findProviderDefinition } from './provider-registry.js';

const id = Schema.String.pipe(Schema.decodeTo(Schema.Trim))
  .check(Schema.isMinCodePoints(1))
  .check(Schema.isMaxCodePoints(512));
const provider = id.check(
  Schema.makeFilter((value) =>
    findProviderDefinition(value) === undefined ? { issue: 'Invalid input', path: [] } : undefined
  )
);
const effort = Schema.Literals(OPENAI_REASONING_EFFORT_VALUES);
const summary = Schema.Literals(['auto', 'detailed']);
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** The same generation fields represented by RuntimeData; transport credentials are excluded. */
export const childGenerationOptionsSchema = Schema.Struct({
  anthropic: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max'])),
      thinking: Schema.optional(
        Schema.Union(
          [
            Schema.Struct({
              display: Schema.optional(Schema.Literals(['omitted', 'summarized', 'updates'])),
              type: Schema.Literal('adaptive'),
            }),
            Schema.Struct({ budgetTokens: count, type: Schema.Literal('enabled') }),
            Schema.Struct({ type: Schema.Literal('disabled') }),
          ],
          { mode: 'oneOf' }
        )
      ),
    })
  ),
  bedrock: Schema.optional(
    Schema.Struct({
      reasoningConfig: Schema.optional(
        Schema.Struct({
          budgetTokens: Schema.optional(count),
          display: Schema.optional(Schema.Literals(['omitted', 'summarized'])),
          maxReasoningEffort: Schema.optional(
            Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max'])
          ),
          type: Schema.Literals(['adaptive', 'disabled', 'enabled']),
        })
      ),
    })
  ),
  google: Schema.optional(
    Schema.Struct({
      thinkingConfig: Schema.optional(
        Schema.Struct({
          includeThoughts: Schema.optional(Schema.Boolean),
          thinkingBudget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
          thinkingLevel: Schema.optional(Schema.Literals(['minimal', 'low', 'medium', 'high'])),
        })
      ),
    })
  ),
  local: Schema.optional(
    Schema.Struct({
      thinking: Schema.optional(Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    })
  ),
  openai: Schema.optional(
    Schema.Struct({
      reasoningEffort: Schema.optional(effort),
      reasoningSummary: Schema.optional(summary),
    })
  ),
  openrouter: Schema.optional(
    Schema.Struct({
      provider: Schema.Struct({ ['require_parameters']: Schema.Literal(true) }),
      reasoning: Schema.optional(
        Schema.Struct({
          effort: Schema.optional(effort),
          enabled: Schema.optional(Schema.Boolean),
          exclude: Schema.optional(Schema.Boolean),
          summary: Schema.optional(summary),
        })
      ),
    })
  ),
});
export const childModelSettingsSchema = Schema.Struct({
  frequencyPenalty: Schema.optional(Schema.Finite),
  maxOutputTokens: Schema.optional(count.check(Schema.isGreaterThan(0))),
  presencePenalty: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
});
/** Requested settings can only reduce tools. The caller cannot supply a permission snapshot. */
export const childNextRunSchema = Schema.Struct({
  disabledToolIds: Schema.optional(Schema.mutable(Schema.Array(id))),
  model: Schema.optional(Schema.Struct({ modelId: id, provider })),
  modelSettings: Schema.optional(childModelSettingsSchema),
  planMode: Schema.optional(Schema.Boolean),
  providerOptions: Schema.optional(childGenerationOptionsSchema),
  requestedReasoningEffort: Schema.optional(effort),
});
export type ChildNextRun = (typeof childNextRunSchema)['Type'];
const decision = Schema.Literals(['allow', 'ask', 'deny']);
const risk = Schema.Literals(['read', 'edit', 'execute', 'mcp']);
const permissionSchema = Schema.Struct({
  defaultRisk: Schema.optional(risk),
  perToolOverrides: Schema.optional(Schema.Record(Schema.String, decision)),
  policies: Schema.Struct({ edit: decision, execute: decision, mcp: decision, read: decision }),
  riskByTool: Schema.optional(Schema.Record(Schema.String, risk)),
  sessionGrants: Schema.optional(Schema.mutable(Schema.Array(risk))),
  yolo: Schema.Boolean,
});
export const childExecutionConfigurationSchema = Schema.Struct({
  model: id,
  modelSettings: Schema.optional(childModelSettingsSchema),
  permissionPolicy: Schema.optional(permissionSchema),
  planMode: Schema.Boolean,
  provider,
  providerOptions: Schema.optional(childGenerationOptionsSchema),
  requestedReasoningEffort: Schema.optional(effort),
});
export type ChildExecutionConfiguration = Defined<
  (typeof childExecutionConfigurationSchema)['Type']
>;
export function readChildExecutionConfiguration(value: unknown): ChildExecutionConfiguration {
  return omitUndefined(
    Schema.decodeUnknownSync(childExecutionConfigurationSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(value)
  );
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
