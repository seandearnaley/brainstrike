/**
 * The zod twin of every Effect-authored native tool input schema.
 *
 * `provider-schema-selection.integration.test.ts` pairs each entry with the
 * tool's REGISTERED schema and asserts both reach all three providers as the
 * same JSON Schema. The twin is the reference for "what zod advertised", so an
 * entry is written to mirror the zod it replaced — except where the Effect
 * producer deliberately spells a keyword differently, which each entry's
 * comment names.
 *
 * It lives here rather than in the test because the catalog is data and the
 * test file is already at its line budget.
 */
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { z } from 'zod';

export const effectAuthoredSlice = [
  [
    NATIVE_TOOL_ID.listWorktrees,
    z
      .object({
        root: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe('Workspace root id or display name; omit to list every open root'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.manageWorktree,
    z
      .object({
        action: z.enum(['create', 'archive']).describe('Worktree operation'),
        baseRef: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Base ref for create; defaults to HEAD'),
        branch: z.string().min(1).max(255).optional().describe('Required for create'),
        force: z
          .boolean()
          .optional()
          .describe('Archive a dirty or unpushed worktree anyway; never overrides an active run'),
        name: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe('Directory name; defaults to the branch name'),
        root: z.string().min(1).max(512).optional().describe('Workspace root id or display name'),
        worktreeId: z.string().min(1).optional().describe('Required for archive'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.browserNavigate,
    z.object({ url: z.string().min(1).max(4096).describe('URL to open') }).strict(),
  ],
  // The two defaulted properties are the reason this pair is here: zod's
  // `.default()` both advertises `default:` and fills an absent key, and Effect
  // spells those as two separate declarations. If the conversion had kept only
  // the advertised half, `maxChars` would reach the driver as `undefined` and
  // its output cap would silently stop applying.
  [
    NATIVE_TOOL_ID.browserReadPage,
    z
      .object({
        filter: z
          .enum(['interactive', 'all'])
          .default('interactive')
          .describe("'interactive' returns only actionable elements; 'all' the full tree"),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(30_000)
          .default(6000)
          .describe('Maximum characters of tree text to return'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.browserGetPageText,
    z
      .object({
        maxChars: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .default(6000)
          .describe('Maximum characters to return'),
      })
      .strict(),
  ],
  // `since` / `until` carry the only string minimum above 1 in the converted
  // set. `Schema.isMinLength(20)` emits `minLength: 10` (UTF-16 code units
  // halved to a sound code-point bound), so this pair is what pins the
  // conversion to `isMinCodePoints` and keeps the advertised bound the real
  // one.
  [
    NATIVE_TOOL_ID.queryDiagnostics,
    z
      .object({
        fingerprint: z.string().min(1).max(256).optional().describe('Exact diagnostic fingerprint'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Maximum events or groups to inspect (default 50, hard max 200)'),
        mode: z
          .enum(['events', 'fingerprints'])
          .describe('events returns newest rows; fingerprints groups recurring failures'),
        runId: z.string().min(1).max(256).optional().describe('Exact assistant run id'),
        severity: z.enum(['warn', 'error', 'fatal']).optional().describe('Exact severity'),
        since: z
          .string()
          .min(20)
          .max(35)
          .optional()
          .describe('Inclusive ISO-8601 lower bound, e.g. 2026-07-20T00:00:00Z'),
        threadId: z.string().min(1).max(256).optional().describe('Exact assistant thread id'),
        until: z
          .string()
          .min(20)
          .max(35)
          .optional()
          .describe('Inclusive ISO-8601 upper bound, e.g. 2026-07-28T00:00:00Z'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.listEmbeddingSpaces,
    z
      .object({
        includeStats: z.boolean().optional().describe('Include coverage statistics'),
        workspaceIndexOnly: z
          .boolean()
          .optional()
          .describe('Only return the embedding space configured as the current workspace index'),
      })
      .strict(),
  ],
  // The three below carry nested closed objects inside a bounded array. The
  // producer fixes `onExcessProperty: 'error'` once for the whole document, so
  // these prove the item objects close as each `.strict()` did rather than only
  // the root.
  [
    NATIVE_TOOL_ID.manageTaskList,
    z
      .object({
        tasks: z
          .array(
            z
              .object({
                activeForm: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe('Present-tense in-progress label, e.g. "Implementing the parser"'),
                content: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe('Imperative task label, e.g. "Implement the parser"'),
                status: z
                  .enum(['pending', 'in_progress', 'completed'])
                  .describe('Task status; keep exactly one task in_progress'),
              })
              .strict()
          )
          .max(50)
          .describe(
            'The full task list to store (whole-list replace — pass the entire desired list every call). Maximum 50 tasks.'
          ),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.submitPlan,
    z
      .object({
        overview: z
          .string()
          .min(1)
          .max(4000)
          .describe('One or two paragraphs summarizing the plan and its goal.'),
        risks: z
          .string()
          .max(4000)
          .optional()
          .describe('Optional risks, tradeoffs, or things that could go wrong.'),
        steps: z
          .array(
            z
              .object({
                detail: z
                  .string()
                  .max(2000)
                  .optional()
                  .describe('Optional elaboration of the step (what/why/how).'),
                title: z.string().min(1).max(500).describe('Short imperative step title.'),
              })
              .strict()
          )
          .min(1)
          .max(30)
          .describe('Ordered implementation steps.'),
        title: z.string().min(1).max(300).describe('Short title for the plan.'),
        verification: z
          .string()
          .max(4000)
          .optional()
          .describe('Optional how-to-verify: tests, checks, or acceptance criteria.'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.askUser,
    z
      .object({
        options: z
          .array(
            z
              .object({
                description: z
                  .string()
                  .max(1000)
                  .optional()
                  .describe('Optional context for the option (does not change the answer value).'),
                label: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe('Option label; the value returned when chosen.'),
              })
              .strict()
          )
          .min(1)
          .max(10)
          .optional()
          .describe('Optional choices. Omit for a free-text question.'),
        question: z
          .string()
          .min(1)
          .max(2000)
          .describe('The clear, specific question to ask the user.'),
        selectionMode: z
          .enum(['single_select', 'multi_select'])
          .optional()
          .describe(
            'How many options the user may pick. Requires options; defaults to single_select.'
          ),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.executeCommand,
    z
      .object({
        command: z
          .string()
          .min(1)
          .max(10_000)
          .describe('Shell command passed verbatim to `-c`; NO sandbox'),
        cwd: z
          .string()
          .optional()
          .describe(
            'Start directory, absolute or root-relative; must resolve inside an open folder'
          ),
        root: z
          .string()
          .optional()
          .describe('Open-folder name/id; required only with multiple folders'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe('Process-tree timeout ms (default 120000, max 600000)'),
      })
      .strict(),
  ],
  // The policy domain grammar is four `Schema.makeFilter`s, which advertise
  // nothing — exactly as the zod `.refine()` chain did. If a conversion had
  // reached for `Schema.isPattern` instead, a `pattern` keyword would appear
  // here and this pair would fail.
  [
    NATIVE_TOOL_ID.runPython,
    z
      .object({
        allowedDomains: z
          .array(z.string().min(1).max(253))
          .max(256)
          .optional()
          .describe(
            'Public domains the script may reach, by name (e.g. "pypi.org", "*.example.com"); [] or omitted for no network. IP literals, localhost, and .local are not allowed. Each domain requires explicit user approval per call.'
          ),
        code: z
          .string()
          .min(1)
          .max(1_000_000)
          .describe('Python source to run as a script; print() to return values'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe('Wall-clock limit ms (default 30000, max 600000)'),
      })
      .strict(),
  ],
  // `cwd` and `scriptPath` share one filtered path grammar and still carry
  // their own descriptions. effect 4.0.4 DROPS a schema annotation applied
  // after a custom `makeFilter`, so this pair is what pins the conversion to
  // annotating before the filter; `timeoutMs` deliberately has no description
  // (native-tool-prompt-budget.test.ts).
  [
    NATIVE_TOOL_ID.runSkillScript,
    z
      .object({
        args: z.array(z.string().max(2000)).max(64).optional().describe('Literal argv'),
        cwd: z.string().min(1).max(1000).describe('Root-relative working directory'),
        root: z.string().min(1).max(500).describe('Mounted root name or id'),
        runtime: z.enum(['bash', 'node', 'python3']).describe('Script interpreter'),
        scriptPath: z.string().min(1).max(1000).describe('Listed scripts/... path'),
        skillName: z
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
          .describe('Enabled skill name'),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      })
      .strict(),
  ],
  // The two below are the first converted ACTION UNIONS, and their twins
  // deviate from the zod they replace in exactly two places, both deliberate:
  //
  // - `z.union`, not `z.discriminatedUnion`: effect 4.0.4 lowers a
  //   `mode: 'oneOf'` union to `anyOf` whenever a member carries
  //   `Schema.isMaxLength`, which `sessionId`/`command`/`data` all do. The
  //   decoder still requires exactly one match.
  // - `z.enum(['list'])`, not `z.literal('list')`: Effect emits a discriminant
  //   as a one-element `enum` where zod emitted `const`.
  //
  // `normalizeProviderNulls` reads either keyword and either discriminant
  // spelling by design, and the catalog spec's `operation: { action: 'list',
  // offset: null }` case is what proves branch selection still works.
  [
    NATIVE_TOOL_ID.inspectCommandSessions,
    z
      .object({
        operation: z
          .union([
            z
              .object({
                action: z.enum(['list']),
                offset: z
                  .number()
                  .int()
                  .min(0)
                  .max(10_000)
                  .optional()
                  .describe('Session offset from a previous truncated list page'),
              })
              .strict(),
            z
              .object({
                action: z.enum(['read']),
                // No explicit maximum: zod's `.int()` advertises
                // `Number.MAX_SAFE_INTEGER`, which the Effect side declares
                // outright so the advertised bound stays the same.
                cursor: z
                  .number()
                  .int()
                  .min(-1)
                  .optional()
                  .describe(
                    'Absolute read cursor; omit for retained output or use -1 for the live tail'
                  ),
                sessionId: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe('Opaque session id returned by start or list'),
              })
              .strict(),
          ])
          .describe('Exactly one inspection operation and only its valid fields'),
        root: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Open folder name or durable id; omit when only one folder is open'),
      })
      .strict(),
  ],
  [
    NATIVE_TOOL_ID.manageCommandSession,
    z
      .object({
        operation: z
          .union([
            z
              .object({
                action: z.enum(['start']),
                cols: z.number().int().min(1).max(5000).optional(),
                command: z.string().min(1).max(10_000).describe('Shell command to start'),
                cwd: z
                  .string()
                  .max(4096)
                  .optional()
                  .describe('Absolute or workspace-relative directory inside the selected root'),
                rows: z.number().int().min(1).max(5000).optional(),
              })
              .strict(),
            z
              .object({
                action: z.enum(['write']),
                data: z.string().min(1).max(100_000).describe('Text to write verbatim'),
                sessionId: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe('Opaque session id returned by start or list'),
              })
              .strict(),
            z
              .object({
                action: z.enum(['stop']),
                sessionId: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe('Opaque session id returned by start or list'),
              })
              .strict(),
            z
              .object({
                action: z.enum(['remove']),
                sessionId: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe('Opaque session id returned by start or list'),
              })
              .strict(),
          ])
          .describe('Exactly one process-control operation and only its valid fields'),
        root: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('Open folder name or durable id; omit when only one folder is open'),
      })
      .strict(),
  ],
] as const;
