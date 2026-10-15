/**
 * Input schemas for the task-list tool and the two suspending tools.
 *
 * The three INPUT schemas are authored in Effect Schema: ADR-0004 (amended
 * 2026-10-15) makes Effect the single boundary owner, and
 * `effectToolInputSchema` derives the provider JSON Schema from them.
 *
 * The two RESUME schemas at the bottom stay in zod on purpose — see the note
 * above `SubmitPlanResumeSchema`.
 */
import { Schema } from 'effect';
import { z } from 'zod';
import { effectToolInputSchema } from './effect-tool-input.js';

/**
 * A length-bounded string whose ADVERTISED bounds are the ones it enforces.
 *
 * `isMinCodePoints`, not `isMinLength`: the latter emits
 * `minLength: Math.ceil(n / 2)` and would advertise half the real minimum.
 * `isMaxLength`, not `isMaxCodePoints`: the latter would accept strings the
 * zod version rejected. Arrays are unaffected and use `isMinLength`, which
 * emits `minItems` exactly. See "String length bounds" in
 * `docs/agents/effect-schema-migration.md`.
 */
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinCodePoints(minimum), Schema.isMaxLength(maximum));

/** An optional free-text field with an upper bound but no minimum. */
const capped = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));

// ============================================================================
// Manage Task List Tool Schema
// ============================================================================

const ManageTaskListItemSchema = Schema.Struct({
  activeForm: bounded(1, 500).annotate({
    description: 'Present-tense in-progress label, e.g. "Implementing the parser"',
  }),
  content: bounded(1, 500).annotate({
    description: 'Imperative task label, e.g. "Implement the parser"',
  }),
  status: Schema.Literals(['pending', 'in_progress', 'completed']).annotate({
    description: 'Task status; keep exactly one task in_progress',
  }),
});

export const ManageTaskListInputSchema = Schema.Struct({
  tasks: Schema.Array(ManageTaskListItemSchema).check(Schema.isMaxLength(50)).annotate({
    description:
      'The full task list to store (whole-list replace — pass the entire desired list every call). Maximum 50 tasks.',
  }),
});

export type ManageTaskListInput = typeof ManageTaskListInputSchema.Type;

// ============================================================================
// Submit Plan Tool Schema (suspending tool)
// ============================================================================

const SubmitPlanStepSchema = Schema.Struct({
  detail: Schema.optionalKey(
    capped(2000).annotate({ description: 'Optional elaboration of the step (what/why/how).' })
  ),
  title: bounded(1, 500).annotate({ description: 'Short imperative step title.' }),
});

/**
 * The authored object. `SubmitPlanInputSchema` below is the registered value,
 * so the struct is kept separately for `SubmitPlanInput` — the producer's
 * output carries its `Type` only as a phantom.
 */
const SubmitPlanInputObjectSchema = Schema.Struct({
  overview: bounded(1, 4000).annotate({
    description: 'One or two paragraphs summarizing the plan and its goal.',
  }),
  risks: Schema.optionalKey(
    capped(4000).annotate({
      description: 'Optional risks, tradeoffs, or things that could go wrong.',
    })
  ),
  steps: Schema.Array(SubmitPlanStepSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(30))
    .annotate({ description: 'Ordered implementation steps.' }),
  title: bounded(1, 300).annotate({ description: 'Short title for the plan.' }),
  verification: Schema.optionalKey(
    capped(4000).annotate({
      description: 'Optional how-to-verify: tests, checks, or acceptance criteria.',
    })
  ),
});

export const SubmitPlanInputSchema = effectToolInputSchema(SubmitPlanInputObjectSchema);

export type SubmitPlanInput = typeof SubmitPlanInputObjectSchema.Type;

// ============================================================================
// Ask User Tool Schema (suspending tool)
// ============================================================================

const AskUserOptionSchema = Schema.Struct({
  description: Schema.optionalKey(
    capped(1000).annotate({
      description: 'Optional context for the option (does not change the answer value).',
    })
  ),
  label: bounded(1, 500).annotate({
    description: 'Option label; the value returned when chosen.',
  }),
});

/** See `SubmitPlanInputObjectSchema` for why the struct is kept separately. */
const AskUserInputObjectSchema = Schema.Struct({
  options: Schema.optionalKey(
    Schema.Array(AskUserOptionSchema)
      .check(Schema.isMinLength(1), Schema.isMaxLength(10))
      .annotate({ description: 'Optional choices. Omit for a free-text question.' })
  ),
  question: bounded(1, 2000).annotate({
    description: 'The clear, specific question to ask the user.',
  }),
  selectionMode: Schema.optionalKey(
    Schema.Literals(['single_select', 'multi_select']).annotate({
      description:
        'How many options the user may pick. Requires options; defaults to single_select.',
    })
  ),
});

export const AskUserInputSchema = effectToolInputSchema(AskUserInputObjectSchema);

export type AskUserInput = typeof AskUserInputObjectSchema.Type;

const AskUserAnswerSchema = z.union([z.string(), z.array(z.string())]);

/**
 * The resume schemas are NOT tool input schemas and are deliberately still zod.
 *
 * `effectToolInputSchema` is the model-facing tool producer: it fixes
 * `onExcessProperty: 'error'`, so admitting a resume envelope through it would
 * CLOSE an object that zod leaves open to strip, and an unknown rider on a
 * person's answer would then strand a suspended run instead of being dropped.
 * A resume envelope is also never advertised to a provider — it travels
 * host↔Core as the platform selection's `interaction.resumeSchema` — so the
 * producer's pairing of a provider JSON Schema with a validator buys nothing
 * here, and the catalog's one-producer guard sweeps
 * `NATIVE_TOOL_INPUT_SCHEMAS`, which these are not in.
 *
 * Converting them means either a second Effect producer with open-object
 * semantics or a ruling that the resume envelope should close. That is an
 * owner decision, like `skill` / `runPython` in
 * `docs/agents/effect-schema-migration.md`, not part of this conversion.
 */
/** submitPlan's resume: the person's decision, with optional feedback. */
export const SubmitPlanResumeSchema = z.object({
  action: z.enum(['approved', 'rejected']),
  feedback: z.string().optional(),
});

/**
 * askUser's resume: the canonical `{answer}` envelope, an object so the
 * resume transport can attach the 1.56+ `approved: true` rider when askUser is
 * ask-gated, declared rather than left to zod's strip. The bare string or
 * string[] arm is legacy compat for runs suspended before the envelope
 * migration; remove it once no pre-migration snapshots can remain.
 */
export const AskUserResumeSchema = z.union([
  z.object({ answer: AskUserAnswerSchema, approved: z.literal(true).optional() }),
  AskUserAnswerSchema,
]);
