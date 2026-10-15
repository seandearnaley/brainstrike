/**
 * Input schemas for the execution tools: shell commands, sandboxed Python,
 * skill scripts, and the persistent PTY command sessions.
 *
 * Authored in Effect Schema: ADR-0004 (amended 2026-10-15) makes Effect the
 * single boundary owner, and `effectToolInputSchema` derives the provider JSON
 * Schema from these declarations.
 */
import { Schema, type SchemaAST } from 'effect';
import { effectToolInputSchema } from './effect-tool-input.js';
import {
  MAX_EXEC_CODE_LENGTH,
  MAX_EXEC_TIMEOUT_MS,
  MAX_POLICY_ENTRIES,
  policyDomainSchema,
} from './exec-policy-domain.js';

/**
 * A length-bounded string whose ADVERTISED bounds are the ones it enforces.
 *
 * `isMinCodePoints`, not `isMinLength`: the latter emits
 * `minLength: Math.ceil(n / 2)` and would advertise half the real minimum. See
 * "String length bounds" in `docs/agents/effect-schema-migration.md`.
 */
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinCodePoints(minimum), Schema.isMaxLength(maximum));

/** An optional free-text field with an upper bound but no minimum. */
const capped = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));

/**
 * A positive integer with an upper bound, as `z.number().int().positive()`
 * spelled it: `isGreaterThan(0)` is the exclusive bound zod advertised as
 * `exclusiveMinimum: 0`.
 */
const positiveIntUpTo = (maximum: number) =>
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximum));

export const ExecuteCommandInputSchema = Schema.Struct({
  command: bounded(1, 10_000).annotate({
    description: 'Shell command passed verbatim to `-c`; NO sandbox',
  }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Start directory, absolute or root-relative; must resolve inside an open folder',
    })
  ),
  root: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Open-folder name/id; required only with multiple folders',
    })
  ),
  timeoutMs: Schema.optionalKey(
    positiveIntUpTo(600_000).annotate({
      description: 'Process-tree timeout ms (default 120000, max 600000)',
    })
  ),
});

export type ExecuteCommandInput = typeof ExecuteCommandInputSchema.Type;

const ROOT_RELATIVE_PATH_MAX = 1000;

/** The root-relative path grammar, written once for both properties that use it. */
const isRootRelativePath = Schema.makeFilter<string>((value) =>
  value === '.' ||
  (!(value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'))
    ? undefined
    : 'Must be a canonical root-relative path without traversal'
);

/**
 * A described root-relative path, optionally with further rules.
 *
 * The description is annotated on `Schema.String` BEFORE the checks rather
 * than on the finished schema: effect 4.0.4 drops a schema-level annotation
 * applied after a custom `makeFilter`, so `x.check(makeFilter(…)).annotate({
 * description })` advertises no description at all. That also rules out a
 * single shared constant carrying a per-use-site description, which is why the
 * grammar above is a shared FILTER and this helper composes it.
 */
const rootRelativePath = (description: string, ...extra: readonly SchemaAST.Check<string>[]) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinCodePoints(1),
    Schema.isMaxLength(ROOT_RELATIVE_PATH_MAX),
    isRootRelativePath,
    ...extra
  );

/**
 * run_python's domain grammar: the seam's `policyDomainSchema` PLUS a
 * public-host requirement (#2225 review). The generic policy grammar accepts
 * anything hostname-shaped, which includes `localhost`, bare IPv4 literals
 * (`127.0.0.1`, `192.168.1.10`, `169.254.169.254`), and mDNS `.local` names —
 * all of which the escalation card would present as "the internet" while the
 * actual grant is services on the user's own machine or network (a local
 * Ollama, a dev database, a cloud metadata endpoint). Model-authored code
 * gets no such grant: name a public domain or run offline.
 */
const IPV4_LITERAL_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const runPythonDomainSchema = policyDomainSchema.check(
  Schema.makeFilter((value) =>
    IPV4_LITERAL_PATTERN.test(value)
      ? 'IP literals are not allowed; name a public domain'
      : undefined
  ),
  Schema.makeFilter((value) => {
    const host = value.startsWith('*.') ? value.slice(2) : value;
    return host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === 'local' ||
      host.endsWith('.local')
      ? 'localhost and .local addresses are not allowed; name a public domain'
      : undefined;
  })
);

/**
 * The authored object. `RunPythonInputSchema` below is the registered value,
 * so the struct is kept separately for `RunPythonInput` — the producer's
 * output carries its `Type` only as a phantom.
 */
const RunPythonInputObjectSchema = Schema.Struct({
  allowedDomains: Schema.optionalKey(
    Schema.Array(runPythonDomainSchema)
      // No minimum: OpenAI's strict function-calling emits EVERY declared
      // property, so an offline call must be representable as an explicit
      // empty array (#2225 review). [] and omitted both mean no network.
      .check(Schema.isMaxLength(MAX_POLICY_ENTRIES))
      .annotate({
        description:
          'Public domains the script may reach, by name (e.g. "pypi.org", "*.example.com"); [] or omitted for no network. IP literals, localhost, and .local are not allowed. Each domain requires explicit user approval per call.',
      })
  ),
  code: bounded(1, MAX_EXEC_CODE_LENGTH).annotate({
    description: 'Python source to run as a script; print() to return values',
  }),
  timeoutMs: Schema.optionalKey(
    positiveIntUpTo(MAX_EXEC_TIMEOUT_MS).annotate({
      description: 'Wall-clock limit ms (default 30000, max 600000)',
    })
  ),
});

/**
 * Registered through the producer HERE rather than in the definition, because
 * the agent package parses `run_python` input against this same constant
 * (`run-python-tool.ts`, `run-python-approval-context.ts`) and those call sites
 * must get the provider-`null` normalization the wire gets. `run-python.ts`
 * therefore registers it unwrapped, as `askUser` and `submitPlan` do.
 */
export const RunPythonInputSchema = effectToolInputSchema(RunPythonInputObjectSchema);

export type RunPythonInput = typeof RunPythonInputObjectSchema.Type;

export const RunSkillScriptInputSchema = Schema.Struct({
  args: Schema.optionalKey(
    Schema.Array(capped(2000))
      .check(Schema.isMaxLength(64))
      .annotate({ description: 'Literal argv' })
  ),
  cwd: rootRelativePath('Root-relative working directory'),
  root: bounded(1, 500).annotate({ description: 'Mounted root name or id' }),
  runtime: Schema.Literals(['bash', 'node', 'python3']).annotate({
    description: 'Script interpreter',
  }),
  scriptPath: rootRelativePath(
    'Listed scripts/... path',
    Schema.makeFilter<string>((value) =>
      value.startsWith('scripts/') && value.split('/').length >= 2
        ? undefined
        : 'Must begin with scripts/'
    )
  ),
  // The Unicode flag is what makes Effect emit the `pattern` keyword zod's
  // `.regex()` emitted unconditionally; the source is unchanged.
  skillName: Schema.String.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
  ).annotate({ description: 'Enabled skill name' }),
  // No wire `description` on purpose: this tool's numbers are stated in the
  // definition's inspector-only `display.timeoutMs`, because every described
  // field is billed against the native-tool prompt budget
  // (native-tool-prompt-budget.test.ts).
  timeoutMs: Schema.optionalKey(positiveIntUpTo(600_000)),
}).check(
  Schema.makeFilter((input) => {
    const totalArgChars = (input.args ?? []).reduce((total, value) => total + value.length, 0);
    return totalArgChars > 16_000
      ? { issue: 'Combined arguments exceed the 16000-character cap', path: ['args'] }
      : undefined;
  })
);

export type RunSkillScriptInput = typeof RunSkillScriptInputSchema.Type;

// ============================================================================
// Persistent Command Session Tool Schemas
// ============================================================================

const CommandSessionRootSchema = bounded(1, 500).annotate({
  description: 'Open folder name or durable id; omit when only one folder is open',
});

const CommandSessionIdSchema = bounded(1, 200).annotate({
  description: 'Opaque session id returned by start or list',
});

/**
 * `mode: 'oneOf'` is the discriminated-union semantic `z.discriminatedUnion`
 * carried: the decoder requires EXACTLY one matching member, so a future
 * branch that overlaps another is a decode failure rather than a silent
 * first-match. The default, `anyOf`, accepts the first match.
 *
 * The ADVERTISED keyword still lowers to `anyOf` for both unions below,
 * because effect 4.0.4 downgrades an emitted `oneOf` whenever any member
 * carries `Schema.isMaxLength` — `sessionId`/`command`/`data` all do. That is
 * the one deliberate wire change in this conversion and it is the safe
 * direction: OpenAI's structured-output dialect supports `anyOf` and rejects
 * `oneOf`, and `normalizeProviderNulls` already reads either keyword to pick a
 * branch. The discriminant also moves from zod's `const: 'start'` to Effect's
 * one-element `enum: ['start']`, which that normalizer likewise reads by
 * design.
 *
 * The branches CLOSE rather than strip, as their `.strict()` did: the union is
 * decoded as part of the envelope, so the producer's `onExcessProperty:
 * 'error'` reaches them.
 */
const DISCRIMINATED = { mode: 'oneOf' } as const;

export const InspectCommandSessionsInputSchema = Schema.Struct({
  operation: Schema.Union(
    [
      Schema.Struct({
        action: Schema.Literal('list'),
        offset: Schema.optionalKey(
          Schema.Int.check(
            Schema.isGreaterThanOrEqualTo(0),
            Schema.isLessThanOrEqualTo(10_000)
          ).annotate({ description: 'Session offset from a previous truncated list page' })
        ),
      }),
      Schema.Struct({
        action: Schema.Literal('read'),
        cursor: Schema.optionalKey(
          // The upper bound is explicit because zod's `.int()` advertised
          // `maximum: Number.MAX_SAFE_INTEGER` whenever no narrower maximum
          // was declared, and this cursor has none.
          Schema.Int.check(
            Schema.isGreaterThanOrEqualTo(-1),
            Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
          ).annotate({
            description:
              'Absolute read cursor; omit for retained output or use -1 for the live tail',
          })
        ),
        sessionId: CommandSessionIdSchema,
      }),
    ],
    DISCRIMINATED
  ).annotate({ description: 'Exactly one inspection operation and only its valid fields' }),
  root: Schema.optionalKey(CommandSessionRootSchema),
});

export type InspectCommandSessionsInput = typeof InspectCommandSessionsInputSchema.Type;

export const ManageCommandSessionInputSchema = Schema.Struct({
  operation: Schema.Union(
    [
      Schema.Struct({
        action: Schema.Literal('start'),
        cols: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5000))
        ),
        command: bounded(1, 10_000).annotate({ description: 'Shell command to start' }),
        cwd: Schema.optionalKey(
          capped(4096).annotate({
            description: 'Absolute or workspace-relative directory inside the selected root',
          })
        ),
        rows: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5000))
        ),
      }),
      Schema.Struct({
        action: Schema.Literal('write'),
        data: bounded(1, 100_000).annotate({ description: 'Text to write verbatim' }),
        sessionId: CommandSessionIdSchema,
      }),
      Schema.Struct({ action: Schema.Literal('stop'), sessionId: CommandSessionIdSchema }),
      Schema.Struct({ action: Schema.Literal('remove'), sessionId: CommandSessionIdSchema }),
    ],
    DISCRIMINATED
  ).annotate({ description: 'Exactly one process-control operation and only its valid fields' }),
  root: Schema.optionalKey(CommandSessionRootSchema),
});

export type ManageCommandSessionInput = typeof ManageCommandSessionInputSchema.Type;

/**
 * Narrow a validated envelope to its action branch, for the transcript
 * redaction transforms that must read branch-specific fields.
 *
 * Decoded with Effect's DEFAULT excess-property handling (strip) rather than
 * the producer's `onExcessProperty: 'error'`: the value has already passed the
 * closed boundary, so a residual extra is a tolerated rider and not a reason
 * to fail writing a transcript row. Spelling the closed decision a second time
 * here would make this a second writer for it. Mirrors
 * `normalizeManageWorktreeInput`.
 */
export const normalizeInspectCommandSessionsInput = Schema.decodeUnknownSync(
  InspectCommandSessionsInputSchema
);

/** See {@link normalizeInspectCommandSessionsInput}. */
export const normalizeManageCommandSessionInput = Schema.decodeUnknownSync(
  ManageCommandSessionInputSchema
);
